use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub struct EIP7702Auth {
    /// EOA address => code hash được authorize
    authorized_code_hash: RwLock<HashMap<String, [u8; 32]>>,
    /// EOA address => thời gian hết hạn (0 = vĩnh viễn)
    authorization_expiry: RwLock<HashMap<String, u64>>,
}

impl EIP7702Auth {
    pub fn new() -> Self {
        Self {
            authorized_code_hash: RwLock::new(HashMap::new()),
            authorization_expiry: RwLock::new(HashMap::new()),
        }
    }

    /// Authorize EOA để chạy code có code_hash.
    pub fn authorize(&self, eo_a: &str, code_hash: [u8; 32], expiry: u64) {
        self.authorized_code_hash.write().unwrap().insert(eo_a.to_string(), code_hash);
        self.authorization_expiry.write().unwrap().insert(eo_a.to_string(), expiry);
    }

    /// Thu hồi quyền authorize của EOA.
    pub fn revoke(&self, eo_a: &str) {
        self.authorized_code_hash.write().unwrap().remove(eo_a);
        self.authorization_expiry.write().unwrap().remove(eo_a);
    }

    /// Kiểm tra xem EOA có được authorize chạy code có code_hash hay không.
    pub fn is_authorized(&self, eo_a: &str, expected_code_hash: &[u8; 32], now: u64) -> bool {
        let hash_map = self.authorized_code_hash.read().unwrap();
        let expiry_map = self.authorization_expiry.read().unwrap();

        let hash = match hash_map.get(eo_a) {
            Some(h) => *h,
            None => return false,
        };

        if hash != *expected_code_hash {
            return false;
        }

        if let Some(expiry) = expiry_map.get(eo_a) {
            if *expiry != 0 && now > *expiry {
                return false;
            }
        }

        true
    }

    /// Lấy code hash đã authorize cho EOA.
    pub fn get_authorized_code_hash(&self, eo_a: &str) -> Option<[u8; 32]> {
        self.authorized_code_hash.read().unwrap().get(eo_a).copied()
    }
}

impl Default for EIP7702Auth {
    fn default() -> Self {
        Self::new()
    }
}
