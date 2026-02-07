use anchor_lang::prelude::*;

/// Compact history summary stored on-chain
///
/// Instead of storing full history, keep aggregates on-chain
/// and emit detailed events for off-chain indexing
///
/// Use cases:
/// - Transaction counts and volumes
/// - Settlement summaries
/// - Activity tracking without state bloat
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct HistorySummary {
    /// Total number of events recorded
    pub total_count: u64,

    /// Sum of values (e.g., total volume)
    pub total_value: u128,

    /// Minimum value seen
    pub min_value: u64,

    /// Maximum value seen
    pub max_value: u64,

    /// Last event slot
    pub last_slot: u64,

    /// Last event timestamp
    pub last_timestamp: i64,

    /// Checksum/hash of last event for verification
    pub last_event_hash: [u8; 32],
}

impl HistorySummary {
    /// Record a new event
    pub fn record(&mut self, value: u64, slot: u64, timestamp: i64) {
        self.total_count = self.total_count.saturating_add(1);
        self.total_value = self.total_value.saturating_add(value as u128);

        // Update min/max
        if self.total_count == 1 {
            self.min_value = value;
            self.max_value = value;
        } else {
            if value < self.min_value {
                self.min_value = value;
            }
            if value > self.max_value {
                self.max_value = value;
            }
        }

        self.last_slot = slot;
        self.last_timestamp = timestamp;
    }

    /// Record event with current clock
    pub fn record_now(&mut self, value: u64) -> Result<()> {
        let clock = Clock::get()?;
        self.record(value, clock.slot, clock.unix_timestamp);
        Ok(())
    }

    /// Set the last event hash (for verification)
    pub fn set_last_hash(&mut self, hash: [u8; 32]) {
        self.last_event_hash = hash;
    }

    /// Get average value (0 if no events)
    pub fn average(&self) -> u64 {
        if self.total_count == 0 {
            return 0;
        }
        (self.total_value / self.total_count as u128) as u64
    }

    /// Check if any events recorded
    pub fn has_events(&self) -> bool {
        self.total_count > 0
    }
}

/// Rolling window summary for time-based stats
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RollingWindow {
    /// Window duration in seconds
    pub window_seconds: i64,

    /// Start of current window
    pub window_start: i64,

    /// Count in current window
    pub window_count: u64,

    /// Value sum in current window
    pub window_value: u128,

    /// Previous window count (for comparison)
    pub prev_window_count: u64,

    /// Previous window value
    pub prev_window_value: u128,
}

impl RollingWindow {
    /// Create a new rolling window
    pub fn new(window_seconds: i64) -> Result<Self> {
        let now = Clock::get()?.unix_timestamp;
        Ok(Self {
            window_seconds,
            window_start: now,
            window_count: 0,
            window_value: 0,
            prev_window_count: 0,
            prev_window_value: 0,
        })
    }

    /// Record an event, rolling window if needed
    pub fn record(&mut self, value: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        // Check if we need to roll the window
        if now >= self.window_start + self.window_seconds {
            // Save current as previous
            self.prev_window_count = self.window_count;
            self.prev_window_value = self.window_value;

            // Reset current
            self.window_start = now;
            self.window_count = 0;
            self.window_value = 0;
        }

        self.window_count = self.window_count.saturating_add(1);
        self.window_value = self.window_value.saturating_add(value as u128);

        Ok(())
    }

    /// Get current window average
    pub fn current_average(&self) -> u64 {
        if self.window_count == 0 {
            return 0;
        }
        (self.window_value / self.window_count as u128) as u64
    }

    /// Get rate of change vs previous window (basis points, 10000 = same)
    pub fn change_rate_bps(&self) -> i32 {
        if self.prev_window_count == 0 {
            return 0;
        }
        let current = self.window_count as i64;
        let prev = self.prev_window_count as i64;
        ((current - prev) * 10000 / prev) as i32
    }
}

/// Event anchor trait - for events that should be archived
pub trait ArchivableEvent: AnchorSerialize {
    /// Get the event type identifier
    fn event_type(&self) -> &'static str;

    /// Get the primary value for summary aggregation
    fn value(&self) -> u64;

    /// Compute hash of the event for verification
    fn compute_hash(&self) -> Result<[u8; 32]> {
        let data = self.try_to_vec()?;
        Ok(simple_hash(&data))
    }
}

/// Simple hash function for when crypto libraries aren't available
fn simple_hash(data: &[u8]) -> [u8; 32] {
    let mut state = [
        0x6a09e667u32, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    for (i, &byte) in data.iter().enumerate() {
        let idx = i % 8;
        state[idx] = state[idx].wrapping_mul(0x01000193).wrapping_add(byte as u32);
        state[(idx + 1) % 8] ^= state[idx].rotate_left(5);
    }

    for _ in 0..4 {
        for i in 0..8 {
            state[i] = state[i].wrapping_mul(0x01000193) ^ state[(i + 1) % 8];
        }
    }

    let mut result = [0u8; 32];
    for (i, &s) in state.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&s.to_le_bytes());
    }
    result
}

/// Helper macro to emit an event and update history summary
#[macro_export]
macro_rules! emit_and_record {
    ($event:expr, $summary:expr) => {{
        let value = $event.value();
        let hash = $event.compute_hash()?;
        $summary.record_now(value)?;
        $summary.set_last_hash(hash);
        emit!($event);
    }};
}

/// Standard event fields that all archivable events should include
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EventMetadata {
    /// Slot when event occurred
    pub slot: u64,
    /// Timestamp when event occurred
    pub timestamp: i64,
    /// Sequence number within the account
    pub sequence: u64,
}

impl EventMetadata {
    pub fn new(sequence: u64) -> Result<Self> {
        let clock = Clock::get()?;
        Ok(Self {
            slot: clock.slot,
            timestamp: clock.unix_timestamp,
            sequence,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_summary() {
        let mut summary = HistorySummary::default();

        summary.record(100, 1, 1000);
        assert_eq!(summary.total_count, 1);
        assert_eq!(summary.total_value, 100);
        assert_eq!(summary.min_value, 100);
        assert_eq!(summary.max_value, 100);

        summary.record(50, 2, 2000);
        summary.record(200, 3, 3000);

        assert_eq!(summary.total_count, 3);
        assert_eq!(summary.total_value, 350);
        assert_eq!(summary.min_value, 50);
        assert_eq!(summary.max_value, 200);
        assert_eq!(summary.average(), 116); // 350 / 3
    }
}
