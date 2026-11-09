//! Fog-of-war bitmaps: base64 encoding with size checks.

use base64::Engine;
use hearth_core::FogMap;

/// Largest bitmap accepted (cells), e.g. a 400×400-cell scene at half-grid resolution.
const MAX_CELLS: u64 = 800 * 800;

pub fn decode(fog: &FogMap) -> Result<Vec<u8>, String> {
    let cells = fog.cols as u64 * fog.rows as u64;
    if cells == 0 || cells > MAX_CELLS {
        return Err("fog map has an invalid size".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&fog.data).map_err(|_| "fog map isn't valid base64")?;
    if bytes.len() as u64 != cells.div_ceil(8) {
        return Err("fog map size doesn't match its data".into());
    }
    Ok(bytes)
}

pub fn encode(bits: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_checks() {
        let fog = FogMap { cols: 10, rows: 3, data: encode(&[0b1010_0001, 0, 0, 0xff]) };
        assert_eq!(decode(&fog).unwrap(), vec![0b1010_0001, 0, 0, 0xff]);
        assert!(decode(&FogMap { cols: 10, rows: 3, data: encode(&[1, 2]) }).is_err(), "wrong length");
        assert!(decode(&FogMap { cols: 0, rows: 3, data: String::new() }).is_err(), "empty");
        assert!(decode(&FogMap { cols: 100_000, rows: 100_000, data: String::new() }).is_err(), "too big");
        assert!(decode(&FogMap { cols: 8, rows: 1, data: "not base64!".into() }).is_err());
    }
}
