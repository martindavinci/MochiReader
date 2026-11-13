// SPDX-License-Identifier: GPL-3.0-or-later
fn main() {
    // Sonic changes the speed of the voices the app says itself. One C file, Apache-2.0: see vendor/sonic.
    cc::Build::new()
        .file("vendor/sonic/sonic.c")
        .warnings(false)
        .compile("sonic");
    println!("cargo:rerun-if-changed=vendor/sonic/sonic.c");
    println!("cargo:rerun-if-changed=vendor/sonic/sonic.h");
    tauri_build::build()
}
