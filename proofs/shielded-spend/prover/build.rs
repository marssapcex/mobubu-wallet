fn main() {
    if std::env::var_os("RISC0_SKIP_BUILD").is_some() {
        panic!("the shielded spend guest must be built");
    }
    risc0_build::embed_methods();
}
