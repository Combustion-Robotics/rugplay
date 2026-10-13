// FILE UPLOAD
export const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// COIN CREATION COSTS
export const CREATION_FEE = 100; // $100 creation fee
export const FIXED_SUPPLY = 1000000000; // 1 billion tokens
export const STARTING_PRICE = 0.000001; // $0.000001 per token
export const INITIAL_LIQUIDITY = FIXED_SUPPLY * STARTING_PRICE; // $1000
export const TOTAL_COST = CREATION_FEE + INITIAL_LIQUIDITY; // $1100

export function getCreationFee(_coinsCreated: number): number {
	return CREATION_FEE;
}

export function getCreationTotalCost(coinsCreated: number): number {
	return getCreationFee(coinsCreated) + INITIAL_LIQUIDITY;
}

// TRADING FEES
// removes currency from circulation on every trade for a tiny whiny fee
export const SWAP_FEE_RATE = 0.003; // 0.3%

// TRANSFER FEES
// Burned on cash transfers between users
export const CASH_TRANSFER_FEE_RATE = 0.01; // 1%

// PROMO CODES
export const MAX_PROMO_REWARD = 1_000_000;

// COMPANIES
export const COMPANY_CREATION_FEE = 1000; // burned
export const COMPANY_TOTAL_SHARES = 1_000_000;
export const COMPANY_MIN_VALUATION = 10_000; // $0.01/share
export const COMPANY_MAX_VALUATION = 100_000_000; // $100/share
export const COMPANY_MIN_OFFER_PERCENT = 5;
export const COMPANY_MAX_OFFER_PERCENT = 50;
export const COMPANY_ROUND_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
export const COMPANY_SECTORS = ['Tech', 'Food', 'Games', 'Energy', 'Health', 'Retail'] as const;
export const COMPANY_QUARTER_MS = 24 * 60 * 60 * 1000; // 1 quarter = 1 real day; no runtime admin settings exist, change here
export const COMPANY_SPENDING_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
// per quarter: spending = money raised × rate; revenue = spending × sector multiplier × random luck in [luckMin, luckMax]
export const COMPANY_SPENDING = {
	LOW: { rate: 0.05, luckMin: 0.9, luckMax: 1.3 },
	MEDIUM: { rate: 0.1, luckMin: 0.6, luckMax: 1.6 },
	HIGH: { rate: 0.3, luckMin: 0, luckMax: 2.1 }
} as const;
export const SECTOR_MULTIPLIER_MIN = 0.5;
export const SECTOR_MULTIPLIER_MAX = 1.5;
export const SECTOR_DRIFT_STEP = 0.15; // max random move per quarter
export const SECTOR_DRIFT_PULL = 0.1; // share of the gap to 1.00 closed each quarter
