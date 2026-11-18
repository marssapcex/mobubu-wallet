use crate::types::{Asset, Note, WithdrawalRequest, WithdrawalProofPacket};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub const SECONDS_PER_YEAR: u128 = 365 * 24 * 60 * 60;
pub const PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

/// YieldVault trong Rust (mirror của Solidity YieldVault).
/// Chạy off-chain hoặc trong canister/smart contract Rust.
pub struct YieldVault {
    pub asset: Asset,
    pub apr_bps: u128, // basis points, ví dụ 500 = 5%
    pub total_assets: RwLock<u128>,
    pub total_y_supply: RwLock<u128>,
    pub user_deposits: RwLock<HashMap<String, u128>>, // user address -> amount gốc
    pub user_last_update: RwLock<HashMap<String, u64>>, // user address -> timestamp
    pub y_token_balances: RwLock<HashMap<String, u128>>, // user address -> yToken balance
}

impl YieldVault {
    pub fn new(asset: Asset, apr_bps: u128) -> Self {
        Self {
            asset,
            apr_bps,
            total_assets: RwLock::new(0),
            total_y_supply: RwLock::new(0),
            user_deposits: RwLock::new(HashMap::new()),
            user_last_update: RwLock::new(HashMap::new()),
            y_token_balances: RwLock::new(HashMap::new()),
        }
    }

    /// Tính lãi pending cho user (không thay đổi state).
    pub fn calculate_pending_interest(&self, user: &str, now: u64) -> u128 {
        let amount = *self.user_deposits.read().unwrap().get(user).unwrap_or(&0);
        if amount == 0 {
            return 0;
        }
        let last_update = *self.user_last_update.read().unwrap().get(user).unwrap_or(&0);
        let elapsed = if now > last_update { now - last_update } else { 0 };
        if elapsed == 0 || self.apr_bps == 0 {
            return 0;
        }
        let numerator = amount * self.apr_bps * elapsed as u128;
        let denominator = SECONDS_PER_YEAR * PRECISION;
        numerator / denominator
    }

    /// Deposit token vào vault, nhận yToken.
    pub fn deposit(&self, user: &str, amount: u128, now: u64) -> anyhow::Result<u128> {
        if amount == 0 {
            return Err(anyhow::anyhow!("amount must be positive"));
        }

        let interest = self.calculate_pending_interest(user, now);
        let mut deposits = self.user_deposits.write().unwrap();
        let mut last_update = self.user_last_update.write().unwrap();
        let mut total_assets = self.total_assets.write().unwrap();
        let mut total_y_supply = self.total_y_supply.write().unwrap();
        let mut y_balances = self.y_token_balances.write().unwrap();

        let current = deposits.get(user).unwrap_or(&0);
        deposits.insert(user.to_string(), current + amount);
        last_update.insert(user.to_string(), now);
        *total_assets += amount;

        // Mint yToken theo tỷ lệ
        let y_tokens_minted = (amount * *total_y_supply) / (*total_assets - amount + 1);
        *total_y_supply += y_tokens_minted;
        let current_y = y_balances.get(user).unwrap_or(&0);
        y_balances.insert(user.to_string(), current_y + y_tokens_minted);

        Ok(y_tokens_minted)
    }

    /// Withdraw yToken, nhận lại gốc + lãi.
    pub fn withdraw(&self, user: &str, y_tokens: u128, now: u64) -> anyhow::Result<u128> {
        let y_balance = *self.y_token_balances.read().unwrap().get(user).unwrap_or(&0);
        if y_tokens > y_balance {
            return Err(anyhow::anyhow!("insufficient yToken balance"));
        }

        let interest = self.calculate_pending_interest(user, now);
        let total_assets_with_interest = *self.total_assets.read().unwrap() + interest;
        let underlying_amount = (y_tokens * total_assets_with_interest) / *self.total_y_supply.read().unwrap();

        if underlying_amount == 0 {
            return Err(anyhow::anyhow!("amount must be positive"));
        }
        if *self.total_assets.read().unwrap() < underlying_amount {
            return Err(anyhow::anyhow!("vault insufficient funds"));
        }

        // Cập nhật state
        {
            let mut deposits = self.user_deposits.write().unwrap();
            let mut last_update = self.user_last_update.write().unwrap();
            let mut total_assets = self.total_assets.write().unwrap();
            let mut total_y_supply = self.total_y_supply.write().unwrap();
            let mut y_balances = self.y_token_balances.write().unwrap();

            let current = deposits.get(user).unwrap_or(&0);
            deposits.insert(user.to_string(), current.saturating_sub(underlying_amount));
            last_update.insert(user.to_string(), now);
            *total_assets -= underlying_amount;
            *total_y_supply -= y_tokens;
            let current_y = y_balances.get(user).unwrap_or(&0);
            y_balances.insert(user.to_string(), current_y - y_tokens);
        }

        Ok(underlying_amount)
    }

    /// Claim chỉ lãi.
    pub fn claim_yield(&self, user: &str, now: u64) -> anyhow::Result<u128> {
        let interest = self.calculate_pending_interest(user, now);
        if interest == 0 {
            return Err(anyhow::anyhow!("no yield to claim"));
        }

        {
            let mut last_update = self.user_last_update.write().unwrap();
            last_update.insert(user.to_string(), now);
        }

        Ok(interest)
    }

    /// Tổng giá trị (gốc + lãi) của user.
    pub fn get_user_total_value(&self, user: &str, now: u64) -> u128 {
        let amount = *self.user_deposits.read().unwrap().get(user).unwrap_or(&0);
        amount + self.calculate_pending_interest(user, now)
    }

    /// Cập nhật APR.
    pub fn update_apr(&mut self, new_apr_bps: u128) -> anyhow::Result<()> {
        if new_apr_bps > 10000 {
            return Err(anyhow::anyhow!("APR too high"));
        }
        self.apr_bps = new_apr_bps;
        Ok(())
    }

    pub fn get_total_assets(&self) -> u128 {
        *self.total_assets.read().unwrap()
    }

    pub fn get_apr(&self) -> u128 {
        self.apr_bps
    }
}

impl Default for YieldVault {
    fn default() -> Self {
        Self::new(Asset::DAI, 500) // 5% APR mặc định
    }
}
