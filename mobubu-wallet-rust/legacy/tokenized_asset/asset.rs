use crate::types::Asset;
use std::sync::{Arc, RwLock};
use std::collections::HashMap;

pub struct TokenizedAsset {
    pub name: String,
    pub symbol: String,
    pub price_oracle: String,
    pub token_to_asset_ratio: u128, // 1 token = ratio / 1e18 đơn vị cổ phiếu
    pub price_usd: RwLock<u128>, // USD, 18 decimals
    pub user_collateral: RwLock<HashMap<String, u128>>, // user -> collateral wei
    pub total_collateral: RwLock<u128>,
    pub total_supply: RwLock<u128>,
    pub balances: RwLock<HashMap<String, u128>>,
}

impl TokenizedAsset {
    pub fn new(
        name: String,
        symbol: String,
        price_oracle: String,
        token_to_asset_ratio: u128,
        initial_price_usd: u128,
    ) -> Self {
        Self {
            name,
            symbol,
            price_oracle,
            token_to_asset_ratio,
            price_usd: RwLock::new(initial_price_usd),
            user_collateral: RwLock::new(HashMap::new()),
            total_collateral: RwLock::new(0),
            total_supply: RwLock::new(0),
            balances: RwLock::new(HashMap::new()),
        }
    }

    /// Cập nhật giá từ oracle.
    pub fn update_price(&self, new_price_usd: u128) {
        *self.price_usd.write().unwrap() = new_price_usd;
    }

    /// Mint tokenized asset bằng cách gửi collateral ETH.
    /// amount_tokens = collateral_usd / price_usd * token_to_asset_ratio
    pub fn mint(
        &self,
        user: &str,
        amount_tokens: u128,
        collateral_wei: u128,
        eth_price_usd: u128, // ETH/USD giá, 18 decimals
    ) -> anyhow::Result<u128> {
        if amount_tokens == 0 {
            return Err(anyhow::anyhow!("amount must be positive"));
        }

        let price_usd = *self.price_usd.read().unwrap();
        let collateral_usd = (amount_tokens * price_usd) / self.token_to_asset_ratio;
        let collateral_needed = (collateral_usd * 1e18 as u128) / eth_price_usd;

        if collateral_wei < collateral_needed {
            return Err(anyhow::anyhow!("insufficient ETH collateral"));
        }

        // Cập nhật collateral
        {
            let mut user_col = self.user_collateral.write().unwrap();
            let current = user_col.get(user).unwrap_or(&0);
            user_col.insert(user.to_string(), current + collateral_needed);
        }
        {
            let mut total = self.total_collateral.write().unwrap();
            *total += collateral_needed;
        }
        {
            let mut supply = self.total_supply.write().unwrap();
            *supply += amount_tokens;
        }
        {
            let mut bal = self.balances.write().unwrap();
            let current = bal.get(user).unwrap_or(&0);
            bal.insert(user.to_string(), current + amount_tokens);
        }

        Ok(amount_tokens)
    }

    /// Redeem token để nhận lại collateral ETH.
    pub fn redeem(
        &self,
        user: &str,
        amount_tokens: u128,
        eth_price_usd: u128,
    ) -> anyhow::Result<u128> {
        if amount_tokens == 0 {
            return Err(anyhow::anyhow!("amount must be positive"));
        }

        let balance = *self.balances.read().unwrap().get(user).unwrap_or(&0);
        if balance < amount_tokens {
            return Err(anyhow::anyhow!("insufficient token balance"));
        }

        let price_usd = *self.price_usd.read().unwrap();
        let collateral_usd = (amount_tokens * price_usd) / self.token_to_asset_ratio;
        let collateral_returned = (collateral_usd * 1e18 as u128) / eth_price_usd;

        let user_col = *self.user_collateral.read().unwrap().get(user).unwrap_or(&0);
        if user_col < collateral_returned {
            return Err(anyhow::anyhow!("insufficient collateral"));
        }

        // Cập nhật state
        {
            let mut user_col = self.user_collateral.write().unwrap();
            *user_col.get_mut(user).unwrap() -= collateral_returned;
        }
        {
            let mut total = self.total_collateral.write().unwrap();
            *total -= collateral_returned;
        }
        {
            let mut supply = self.total_supply.write().unwrap();
            *supply -= amount_tokens;
        }
        {
            let mut bal = self.balances.write().unwrap();
            *bal.get_mut(user).unwrap() -= amount_tokens;
        }

        Ok(collateral_returned)
    }

    /// Tính giá trị USD của một lượng token.
    pub fn token_value_usd(&self, amount_tokens: u128) -> u128 {
        let price_usd = *self.price_usd.read().unwrap();
        (amount_tokens * price_usd) / self.token_to_asset_ratio
    }

    /// Tính số token có thể mint với một lượng collateral ETH.
    pub fn tokens_for_collateral(
        &self,
        collateral_wei: u128,
        eth_price_usd: u128,
    ) -> u128 {
        let price_usd = *self.price_usd.read().unwrap();
        let collateral_usd = (collateral_wei * eth_price_usd) / 1e18 as u128;
        (collateral_usd * self.token_to_asset_ratio) / price_usd
    }

    pub fn get_balance(&self, user: &str) -> u128 {
        *self.balances.read().unwrap().get(user).unwrap_or(&0)
    }

    pub fn get_price_usd(&self) -> u128 {
        *self.price_usd.read().unwrap()
    }
}
