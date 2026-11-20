// Fixed-width byte relation shared by the zkVM guest and the native parity test.
// No modular amount arithmetic: cap and subtract ordinary integers before hashing.
pub const DEPTH: usize = 20;
pub const JOURNAL_LEN: usize = 7 * 32;
pub const WITNESS_LEN: usize = 32 + 16 + 4 + DEPTH * 32 + 32;
const MAX_VALUE: u128 = (1u128 << 96) - 1;
const ZERO: [u8; 32] = [0; 32];

type Hash = [u8; 32];

fn hash65(sha256: impl Fn(&[u8]) -> Hash, tag: u8, a: &Hash, b: &Hash) -> Hash {
    let mut msg = [0u8; 65];
    msg[0] = tag;
    msg[1..33].copy_from_slice(a);
    msg[33..65].copy_from_slice(b);
    sha256(&msg)
}

fn leaf(sha256: impl Fn(&[u8]) -> Hash + Copy, domain: &Hash, secret: &Hash, value: u128) -> Hash {
    let mut msg = [0u8; 81];
    msg[0] = 2;
    msg[1..33].copy_from_slice(domain);
    msg[33..65].copy_from_slice(&hash65(sha256, 1, domain, secret));
    msg[65..81].copy_from_slice(&value.to_be_bytes());
    sha256(&msg)
}

pub fn verify(j: &[u8; JOURNAL_LEN], w: &[u8; WITNESS_LEN], sha256: impl Fn(&[u8]) -> Hash + Copy) -> bool {
    let domain: &Hash = j[0..32].try_into().unwrap();
    let root: &Hash = j[32..64].try_into().unwrap();
    let count = u32::from_be_bytes(j[92..96].try_into().unwrap());
    let nullifier: &Hash = j[96..128].try_into().unwrap();
    let debit = u128::from_be_bytes(j[144..160].try_into().unwrap());
    let change: &Hash = j[160..192].try_into().unwrap();
    let intent: &Hash = j[192..224].try_into().unwrap();
    let secret: &Hash = w[0..32].try_into().unwrap();
    let value = u128::from_be_bytes(w[32..48].try_into().unwrap());
    let index = u32::from_be_bytes(w[48..52].try_into().unwrap());
    let change_secret: &Hash = w[WITNESS_LEN - 32..].try_into().unwrap();
    if *domain == ZERO || *root == ZERO || *nullifier == ZERO || *intent == ZERO || *secret == ZERO ||
        j[64..92] != [0; 28] || j[128..144] != [0; 16] || count > 1 << DEPTH || index >= count ||
        debit == 0 || value > MAX_VALUE || debit > value {
        return false;
    }
    let digest = leaf(sha256, domain, secret, value);
    let mut tag_input = [0u8; 97];
    tag_input[0] = 3;
    tag_input[1..33].copy_from_slice(domain);
    tag_input[33..65].copy_from_slice(secret);
    tag_input[65..97].copy_from_slice(&digest);
    if digest == ZERO || sha256(&tag_input) != *nullifier {
        return false;
    }
    let remainder = value - debit;
    if remainder == 0 {
        if *change != ZERO || *change_secret != ZERO { return false; }
    } else if *change_secret == ZERO || change_secret == secret || *change == ZERO ||
        leaf(sha256, domain, change_secret, remainder) != *change {
        return false;
    }
    let mut node = digest;
    for level in 0..DEPTH {
        let pos = 52 + level * 32;
        let sibling: &Hash = w[pos..pos + 32].try_into().unwrap();
        // Select ordering without taking a branch on the private Merkle index.
        let mask = 0u8.wrapping_sub(((index >> level) & 1) as u8);
        let mut left = [0u8; 32];
        let mut right = [0u8; 32];
        for i in 0..32 {
            let delta = (node[i] ^ sibling[i]) & mask;
            left[i] = node[i] ^ delta;
            right[i] = sibling[i] ^ delta;
        }
        node = hash65(sha256, 4, &left, &right);
    }
    node == *root
}
