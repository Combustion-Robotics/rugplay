import { db } from '$lib/server/db';
import { coin, transaction, priceHistory, userPortfolio, user } from '$lib/server/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { createNotification } from '$lib/server/notification';
import { SWAP_FEE_RATE } from '$lib/data/constants';
import { redis } from '$lib/server/redis';
import { error } from '@sveltejs/kit';

export async function calculate24hMetrics(coinId: number, currentPrice: number, queryCtx: Pick<typeof db, 'select'> = db) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [priceData] = await queryCtx
        .select({ price: priceHistory.price })
        .from(priceHistory)
        .where(and(
            eq(priceHistory.coinId, coinId),
            gte(priceHistory.timestamp, twentyFourHoursAgo)
        ))
        .orderBy(priceHistory.timestamp)
        .limit(1);

    let change24h = 0;
    if (priceData) {
        const priceFrom24hAgo = Number(priceData.price);
        if (priceFrom24hAgo > 0) {
            const raw = ((currentPrice - priceFrom24hAgo) / priceFrom24hAgo) * 100;
            change24h = Math.max(-9999999, Math.min(9999999, raw));
        }
    }

    const [volumeData] = await queryCtx
        .select({ volume: sql<string>`coalesce(sum(${transaction.totalBaseCurrencyAmount}), 0)` })
        .from(transaction)
        .where(and(
            eq(transaction.coinId, coinId),
            gte(transaction.timestamp, twentyFourHoursAgo)
        ));

    const volume24h = Number(volumeData.volume);

    return { change24h: Number(change24h.toFixed(4)), volume24h: Number(volume24h.toFixed(4)) };
}

export async function executeSellTrade(
    tx: any,
    coinData: any,
    userId: number,
    quantity: number
) {
    const poolCoinAmount = Number(coinData.poolCoinAmount);
    const poolBaseCurrencyAmount = Number(coinData.poolBaseCurrencyAmount);
    const currentPrice = Number(coinData.currentPrice);

    if (poolCoinAmount <= 0 || poolBaseCurrencyAmount <= 0) {
        throw new Error('Liquidity pool is not properly initialized or is empty');
    }

    const k = poolCoinAmount * poolBaseCurrencyAmount;
    const newPoolCoin = poolCoinAmount + quantity;
    const newPoolBaseCurrency = k / newPoolCoin;
    const baseCurrencyReceived = poolBaseCurrencyAmount - newPoolBaseCurrency;
    const newPrice = newPoolBaseCurrency / newPoolCoin;

    if (baseCurrencyReceived <= 0 || newPoolBaseCurrency < 1) {
        const fallbackValue = quantity * currentPrice;
        return {
            success: false,
            fallbackValue,
            newPrice: currentPrice,
            priceImpact: 0
        };
    }

    const priceImpact = ((newPrice - currentPrice) / currentPrice) * 100;

    const feeAmount = baseCurrencyReceived * SWAP_FEE_RATE;
    const netReceived = baseCurrencyReceived - feeAmount;

    await tx.insert(transaction).values({
        userId,
        coinId: coinData.id,
        type: 'SELL',
        quantity: quantity.toString(),
        pricePerCoin: (baseCurrencyReceived / quantity).toString(),
        totalBaseCurrencyAmount: baseCurrencyReceived.toString(),
        timestamp: new Date()
    });

    await tx.insert(priceHistory).values({
        coinId: coinData.id,
        price: newPrice.toString()
    });

    const metrics = await calculate24hMetrics(coinData.id, newPrice, tx);

    const MAX_STORABLE = 1e38;
    const safeMarketCap = Math.min(Number(coinData.circulatingSupply) * newPrice, MAX_STORABLE);
    const safeVolume = Math.min(metrics.volume24h, MAX_STORABLE);

    await tx.update(coin)
        .set({
            currentPrice: newPrice.toString(),
            marketCap: safeMarketCap.toString(),
            poolCoinAmount: newPoolCoin.toString(),
            poolBaseCurrencyAmount: newPoolBaseCurrency.toString(),
            change24h: metrics.change24h.toString(),
            volume24h: safeVolume.toString(),
            updatedAt: new Date()
        })
        .where(eq(coin.id, coinData.id));

    const isRugPull = priceImpact < -20 && baseCurrencyReceived > 1000;
    if (isRugPull) {
        (async () => {
            try {
                const affectedUsers = await db
                    .select({
                        userId: userPortfolio.userId,
                        quantity: userPortfolio.quantity
                    })
                    .from(userPortfolio)
                    .where(eq(userPortfolio.coinId, coinData.id));

                for (const holder of affectedUsers) {
                    if (holder.userId === userId) continue;
                    
                    const holdingValue = Number(holder.quantity) * newPrice;
                    if (holdingValue > 10) {
                        await createNotification(
                            holder.userId.toString(),
                            'RUG_PULL',
                            'Coin rugpulled!',
                            `A coin you owned, ${coinData.name} (*${coinData.symbol}), crashed ${Math.abs(priceImpact).toFixed(1)}%!`,
                            `/coin/${coinData.symbol}`
                        );
                    }
                }
            } catch (error) {
                console.error('Error sending rug pull notifications:', error);
            }
        })();
    }

    return {
        success: true,
        baseCurrencyReceived,
        feeAmount,
        netReceived,
        newPrice,
        priceImpact,
        newPoolCoin,
        newPoolBaseCurrency,
        metrics
    };
}

// the trade route and the AI crowd both call this; lock order: user, then coin
export async function executeCoinTrade(userId: number, normalizedSymbol: string, type: 'BUY' | 'SELL', amount: number) {
    const txResult = await db.transaction(async (tx) => {
        const [userData] = await tx.select({
            baseCurrencyBalance: user.baseCurrencyBalance,
            username: user.username,
            image: user.image
        }).from(user).where(eq(user.id, userId)).for('update').limit(1);

        if (!userData) {
            throw error(404, 'User not found');
        }


        const [coinData] = await tx.select({
            id: coin.id,
            symbol: coin.symbol,
            name: coin.name,
            icon: coin.icon,
            currentPrice: coin.currentPrice,
            poolCoinAmount: coin.poolCoinAmount,
            poolBaseCurrencyAmount: coin.poolBaseCurrencyAmount,
            circulatingSupply: coin.circulatingSupply,
            isListed: coin.isListed,
            creatorId: coin.creatorId,
            tradingUnlocksAt: coin.tradingUnlocksAt,
            isLocked: coin.isLocked,
            change24h: coin.change24h,
            createdAt: coin.createdAt
        }).from(coin).where(eq(coin.symbol, normalizedSymbol)).for('update').limit(1);

        if (!coinData) {
            throw error(404, 'Coin not found');
        }

        if (!coinData.isListed) {
            throw error(400, 'This coin is delisted and cannot be traded');
        }

        if (coinData.isLocked && coinData.tradingUnlocksAt && userId !== coinData.creatorId) {
            const unlockTime = new Date(coinData.tradingUnlocksAt);
            if (new Date() < unlockTime) {
                const remainingSeconds = Math.ceil((unlockTime.getTime() - Date.now()) / 1000);
                throw error(400, `Trading is locked. Unlocks in ${remainingSeconds} seconds.`);
            }
            
            await tx.update(coin)
                .set({ isLocked: false })
                .where(eq(coin.id, coinData.id));
        }

        const userBalance = Number(userData.baseCurrencyBalance);
        const poolCoinAmount = Number(coinData.poolCoinAmount);
        const poolBaseCurrencyAmount = Number(coinData.poolBaseCurrencyAmount);
        const currentPrice = Number(coinData.currentPrice);

        let newPrice: number;
        let totalCost: number;
        let priceImpact: number = 0;

        if (poolCoinAmount <= 0 || poolBaseCurrencyAmount <= 0) {
            throw error(400, 'Liquidity pool is not properly initialized or is empty. Trading halted.');
        }

        if (type === 'BUY') {
            // AMM BUY: amount = dollars to spend
            const feeAmount = amount * SWAP_FEE_RATE;
            const amountIntoPool = amount - feeAmount;

            const k = poolCoinAmount * poolBaseCurrencyAmount;
            const newPoolBaseCurrency = poolBaseCurrencyAmount + amountIntoPool;
            const newPoolCoin = k / newPoolBaseCurrency;
            const coinsBought = poolCoinAmount - newPoolCoin;

            totalCost = amount;
            newPrice = newPoolBaseCurrency / newPoolCoin;
            priceImpact = ((newPrice - currentPrice) / currentPrice) * 100;

            if (userBalance < totalCost) {
                throw error(400, `Insufficient funds. You need *${totalCost.toFixed(6)} BUSS but only have *${userBalance.toFixed(6)} BUSS`);
            }

            if (coinsBought <= 0) {
                throw error(400, 'Trade amount too small - would result in zero tokens');
            }

            await tx.update(user)
                .set({
                    baseCurrencyBalance: (userBalance - totalCost).toString(),
                    updatedAt: new Date()
                })
                .where(eq(user.id, userId));

            const [existingHolding] = await tx
                .select({ quantity: userPortfolio.quantity })
                .from(userPortfolio)
                .where(and(
                    eq(userPortfolio.userId, userId),
                    eq(userPortfolio.coinId, coinData.id)
                ))
                .limit(1);

            if (existingHolding) {
                const newQuantity = Number(existingHolding.quantity) + coinsBought;
                await tx.update(userPortfolio)
                    .set({
                        quantity: newQuantity.toString(),
                        updatedAt: new Date()
                    })
                    .where(and(
                        eq(userPortfolio.userId, userId),
                        eq(userPortfolio.coinId, coinData.id)
                    ));
            } else {
                await tx.insert(userPortfolio).values({
                    userId,
                    coinId: coinData.id,
                    quantity: coinsBought.toString()
                });
            }

            await tx.insert(transaction).values({
                userId,
                coinId: coinData.id,
                type: 'BUY',
                quantity: coinsBought.toString(),
                pricePerCoin: (totalCost / coinsBought).toString(),
                totalBaseCurrencyAmount: totalCost.toString()
            });

            await tx.insert(priceHistory).values({
                coinId: coinData.id,
                price: newPrice.toString()
            });

            const metrics = await calculate24hMetrics(coinData.id, newPrice, tx);

            const MAX_STORABLE = 1e38;
            const safeMarketCap = Math.min(Number(coinData.circulatingSupply) * newPrice, MAX_STORABLE);
            const safeVolume = Math.min(metrics.volume24h, MAX_STORABLE);

            await tx.update(coin)
                .set({
                    currentPrice: newPrice.toString(),
                    marketCap: safeMarketCap.toString(),
                    poolCoinAmount: newPoolCoin.toString(),
                    poolBaseCurrencyAmount: newPoolBaseCurrency.toString(),
                    change24h: metrics.change24h.toString(),
                    volume24h: safeVolume.toString(),
                    updatedAt: new Date()
                })
                .where(eq(coin.id, coinData.id));

            const priceUpdateData = {
                currentPrice: newPrice,
                marketCap: safeMarketCap,
                change24h: metrics.change24h,
                volume24h: safeVolume,
                poolCoinAmount: newPoolCoin,
                poolBaseCurrencyAmount: newPoolBaseCurrency
            };

            const tradeData = {
                type: 'BUY' as const,
                username: userData.username,
                userImage: userData.image || '',
                amount: coinsBought,
                coinSymbol: normalizedSymbol,
                coinName: coinData.name,
                coinIcon: coinData.icon || '',
                totalValue: totalCost,
                price: newPrice,
                timestamp: Date.now(),
                userId: userId.toString()
            };

            return {
                tradeType: 'BUY' as const,
                priceUpdateData,
                tradeData,
                totalCost,
                feePaid: feeAmount,
                coinsBought,
                newPrice,
                priceImpact,
                newBalance: userBalance - totalCost,
                coinChange24h: Number(coinData.change24h || 0),
                oldPrice: currentPrice
            };

        } else {
            // AMM SELL: amount = number of coins to sell
            const [userHolding] = await tx
                .select({ quantity: userPortfolio.quantity })
                .from(userPortfolio)
                .where(and(
                    eq(userPortfolio.userId, userId),
                    eq(userPortfolio.coinId, coinData.id)
                ))
                .limit(1);

            if (!userHolding || Number(userHolding.quantity) < amount) {
                throw error(400, `Insufficient coins. You have ${userHolding ? Number(userHolding.quantity) : 0} but trying to sell ${amount}`);
            }

            // Allow more aggressive selling for rug pull simulation - prevent only mathematical breakdown
            const maxSellable = Math.floor(Number(coinData.poolCoinAmount) * 0.995);
            if (amount > maxSellable) {
                throw error(400, `Cannot sell more than 99.5% of pool tokens. Max sellable: ${maxSellable} tokens`);
            }

            const sellResult = await executeSellTrade(tx, coinData, userId, amount);

            if (!sellResult.success) {
                throw error(400, 'Trade failed - insufficient liquidity or invalid parameters');
            }

            const grossReceived = sellResult.baseCurrencyReceived ?? 0;
            const feeAmount = sellResult.feeAmount ?? 0;

            totalCost = sellResult.netReceived ?? 0;
            newPrice = sellResult.newPrice;
            priceImpact = sellResult.priceImpact;

            if (grossReceived <= 0) {
                throw error(400, 'Trade amount results in zero base currency received');
            }

            await tx.update(user)
                .set({
                    baseCurrencyBalance: (userBalance + totalCost).toString(),
                    updatedAt: new Date()
                })
                .where(eq(user.id, userId));

            const newQuantity = Number(userHolding.quantity) - amount;
            if (newQuantity > 0.000001) {
                await tx.update(userPortfolio)
                    .set({
                        quantity: newQuantity.toString(),
                        updatedAt: new Date()
                    })
                    .where(and(
                        eq(userPortfolio.userId, userId),
                        eq(userPortfolio.coinId, coinData.id)
                    ));
            } else {
                await tx.delete(userPortfolio)
                    .where(and(
                        eq(userPortfolio.userId, userId),
                        eq(userPortfolio.coinId, coinData.id)
                    ));
            }

            const metrics = sellResult.metrics || await calculate24hMetrics(coinData.id, newPrice, tx);

            const priceUpdateData = {
                currentPrice: newPrice,
                marketCap: Number(coinData.circulatingSupply) * newPrice,
                change24h: metrics.change24h,
                volume24h: metrics.volume24h,
                poolCoinAmount: sellResult.newPoolCoin,
                poolBaseCurrencyAmount: sellResult.newPoolBaseCurrency
            };

            const tradeData = {
                type: 'SELL' as const,
                username: userData.username,
                userImage: userData.image || '',
                amount: amount,
                coinSymbol: normalizedSymbol,
                coinName: coinData.name,
                coinIcon: coinData.icon || '',
                totalValue: totalCost,
                price: newPrice,
                timestamp: Date.now(),
                userId: userId.toString()
            };

            return {
                tradeType: 'SELL' as const,
                priceUpdateData,
                tradeData,
                totalCost,
                feePaid: feeAmount,
                coinsSold: amount,
                coinId: coinData.id,
                newPrice,
                priceImpact,
                newBalance: userBalance + totalCost,
                coinChange24h: metrics.change24h,
                oldPrice: currentPrice,
                coinCreatedAt: coinData.createdAt
            };
        }
    });

    redis.publish(`prices:${normalizedSymbol}`, JSON.stringify(txResult.priceUpdateData)).catch(console.error);
    redis.publish('trades:all', JSON.stringify({ type: 'all-trades', data: txResult.tradeData })).catch(console.error);
    if (txResult.totalCost >= 1000) {
        redis.publish('trades:large', JSON.stringify({ type: 'live-trade', data: txResult.tradeData })).catch(console.error);
    }

    return txResult;
}
