use anchor_lang::prelude::*;
use crate::errors::StratumError;

/// Standard expiry configuration for accounts that should be cleaned up
///
/// Use cases:
/// - Temporary records that should be removed after some time
/// - Lease contracts that expire
/// - Time-limited access tokens
/// - Cleanup crank rewards
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct ExpiryConfig {
    /// When the record was created
    pub created_at: i64,

    /// When the record expires (0 = never expires)
    pub expires_at: i64,

    /// Grace period after expiry before cleanup is allowed (seconds)
    pub grace_period: i64,

    /// Reward for cleanup crank operator (in lamports)
    pub cleanup_reward: u64,
}

impl ExpiryConfig {
    /// Create a new expiry config with TTL in seconds
    pub fn new(ttl_seconds: i64, grace_period: i64, cleanup_reward: u64) -> Result<Self> {
        let now = Clock::get()?.unix_timestamp;
        Ok(Self {
            created_at: now,
            expires_at: if ttl_seconds > 0 {
                now.checked_add(ttl_seconds).ok_or(StratumError::Overflow)?
            } else {
                0
            },
            grace_period,
            cleanup_reward,
        })
    }

    /// Create expiry config that never expires
    pub fn never() -> Result<Self> {
        let now = Clock::get()?.unix_timestamp;
        Ok(Self {
            created_at: now,
            expires_at: 0,
            grace_period: 0,
            cleanup_reward: 0,
        })
    }

    /// Create expiry config with absolute timestamp
    pub fn at(expires_at: i64, grace_period: i64, cleanup_reward: u64) -> Result<Self> {
        let now = Clock::get()?.unix_timestamp;
        Ok(Self {
            created_at: now,
            expires_at,
            grace_period,
            cleanup_reward,
        })
    }

    /// Check if the record has expired
    pub fn is_expired(&self) -> Result<bool> {
        if self.expires_at == 0 {
            return Ok(false);
        }
        let now = Clock::get()?.unix_timestamp;
        Ok(now > self.expires_at)
    }

    /// Check if cleanup is allowed (expired + grace period passed)
    pub fn can_cleanup(&self) -> Result<bool> {
        if self.expires_at == 0 {
            return Ok(false);
        }
        let now = Clock::get()?.unix_timestamp;
        let cleanup_time = self
            .expires_at
            .checked_add(self.grace_period)
            .ok_or(StratumError::Overflow)?;
        Ok(now > cleanup_time)
    }

    /// Get remaining time until expiry (negative if expired)
    pub fn time_remaining(&self) -> Result<i64> {
        if self.expires_at == 0 {
            return Ok(i64::MAX); // Never expires
        }
        let now = Clock::get()?.unix_timestamp;
        Ok(self.expires_at - now)
    }

    /// Get time since creation
    pub fn age(&self) -> Result<i64> {
        let now = Clock::get()?.unix_timestamp;
        Ok(now - self.created_at)
    }

    /// Extend the expiry time
    pub fn extend(&mut self, additional_seconds: i64) -> Result<()> {
        require!(self.expires_at > 0, StratumError::InvalidConfig);
        self.expires_at = self
            .expires_at
            .checked_add(additional_seconds)
            .ok_or(StratumError::Overflow)?;
        Ok(())
    }

    /// Set expiry to a specific timestamp
    pub fn set_expiry(&mut self, new_expires_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(new_expires_at > now, StratumError::InvalidConfig);
        self.expires_at = new_expires_at;
        Ok(())
    }
}

/// Trait for accounts that have expiry behavior
pub trait Expirable {
    /// Get the expiry configuration
    fn expiry(&self) -> &ExpiryConfig;

    /// Get mutable expiry configuration
    fn expiry_mut(&mut self) -> &mut ExpiryConfig;

    /// Check if expired
    fn is_expired(&self) -> Result<bool> {
        self.expiry().is_expired()
    }

    /// Check if cleanup is allowed
    fn can_cleanup(&self) -> Result<bool> {
        self.expiry().can_cleanup()
    }
}

/// Cleanup receipt - record of a successful cleanup
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CleanupReceipt {
    /// Account that was cleaned up
    pub cleaned_account: Pubkey,

    /// Who performed the cleanup
    pub cleaner: Pubkey,

    /// When cleanup occurred
    pub cleaned_at: i64,

    /// Reward paid to cleaner
    pub reward_paid: u64,

    /// Rent returned to original payer
    pub rent_returned: u64,
}

/// Helper to validate cleanup is allowed
pub fn require_cleanup_allowed(expiry: &ExpiryConfig) -> Result<()> {
    require!(expiry.can_cleanup()?, StratumError::NotExpired);
    Ok(())
}

/// Helper to validate record is not expired
pub fn require_not_expired(expiry: &ExpiryConfig) -> Result<()> {
    require!(!expiry.is_expired()?, StratumError::AlreadyExpired);
    Ok(())
}

/// Calculate cleanup reward based on account size
/// Default: 1% of rent, minimum 5000 lamports
pub fn calculate_cleanup_reward(rent_lamports: u64) -> u64 {
    let reward = rent_lamports / 100; // 1%
    reward.max(5000) // Minimum 5000 lamports
}

/// Time constants for common TTL values
pub mod ttl {
    /// 1 hour in seconds
    pub const HOUR: i64 = 3600;
    /// 1 day in seconds
    pub const DAY: i64 = 86400;
    /// 1 week in seconds
    pub const WEEK: i64 = 604800;
    /// 30 days in seconds
    pub const MONTH: i64 = 2592000;
    /// 365 days in seconds
    pub const YEAR: i64 = 31536000;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: Clock::get() won't work in unit tests, so we test the logic separately
    #[test]
    fn test_ttl_constants() {
        assert_eq!(ttl::HOUR, 3600);
        assert_eq!(ttl::DAY, 86400);
        assert_eq!(ttl::WEEK, 604800);
        assert_eq!(ttl::MONTH, 2592000);
    }

    #[test]
    fn test_cleanup_reward_calculation() {
        // 1% of rent
        assert_eq!(calculate_cleanup_reward(1_000_000), 10_000);
        // Minimum 5000
        assert_eq!(calculate_cleanup_reward(100_000), 5000);
        assert_eq!(calculate_cleanup_reward(0), 5000);
    }
}
