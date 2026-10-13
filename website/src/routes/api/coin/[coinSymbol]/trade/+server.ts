import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { coin, transaction } from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { executeCoinTrade } from '$lib/server/amm';
import { checkAndAwardAchievements } from '$lib/server/achievements';
import { SWAP_FEE_RATE } from '$lib/data/constants';

export async function POST({ params, request }) {
    const session = await auth.api.getSession({
        headers: request.headers
    });

    if (!session?.user) {
        throw error(401, 'Not authenticated');
    }

    const { coinSymbol } = params;
    const { type, amount } = await request.json();

    if (!['BUY', 'SELL'].includes(type)) {
        throw error(400, 'Invalid transaction type');
    }

    if (!amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw error(400, 'Invalid amount - must be a positive finite number');
    }

    if (amount > Number.MAX_SAFE_INTEGER) {
        throw error(400, 'Amount too large');
    }

    const userId = Number(session.user.id);
    const normalizedSymbol = coinSymbol.toUpperCase();

    const [coinExists] = await db.select({ id: coin.id }).from(coin).where(eq(coin.symbol, normalizedSymbol)).limit(1);
    if (!coinExists) {
        throw error(404, 'Coin not found');
    }

    const txResult = await executeCoinTrade(userId, normalizedSymbol, type as 'BUY' | 'SELL', amount);

    if (txResult.tradeType === 'BUY') {
        checkAndAwardAchievements(userId, ['trading', 'wealth', 'special'], {
            tradeType: 'BUY',
            tradeAmount: txResult.totalCost,
            coinChange24h: txResult.coinChange24h,
            newBalance: txResult.newBalance,
            newPrice: txResult.newPrice,
            oldPrice: txResult.oldPrice
        });

        return json({
            success: true,
            type: 'BUY',
            coinsBought: txResult.coinsBought,
            totalCost: txResult.totalCost,
            feePaid: txResult.feePaid,
            feeRate: SWAP_FEE_RATE,
            newPrice: txResult.newPrice,
            priceImpact: txResult.priceImpact,
            newBalance: txResult.newBalance
        });
    } else {
        checkAndAwardAchievements(userId, ['trading', 'wealth', 'creation', 'special'], {
            tradeType: 'SELL',
            tradeAmount: txResult.totalCost,
            coinChange24h: txResult.coinChange24h,
            newBalance: txResult.newBalance,
            newPrice: txResult.newPrice,
            oldPrice: txResult.oldPrice,
            coinCreatedAt: txResult.coinCreatedAt,
            firstInvestmentAt: await getFirstBuyTimestamp(userId, txResult.coinId)
        });

        return json({
            success: true,
            type: 'SELL',
            coinsSold: txResult.coinsSold,
            totalReceived: txResult.totalCost,
            feePaid: txResult.feePaid,
            feeRate: SWAP_FEE_RATE,
            newPrice: txResult.newPrice,
            priceImpact: txResult.priceImpact,
            newBalance: txResult.newBalance
        });
    }
}

async function getFirstBuyTimestamp(userId: number, coinId: number): Promise<Date | undefined> {
    try {
        const [firstBuy] = await db
            .select({ timestamp: transaction.timestamp })
            .from(transaction)
            .where(
                and(
                    eq(transaction.userId, userId),
                    eq(transaction.coinId, coinId),
                    eq(transaction.type, 'BUY')
                )
            )
            .orderBy(asc(transaction.timestamp))
            .limit(1);
        return firstBuy?.timestamp ?? undefined;
    } catch {
        return undefined;
    }
}