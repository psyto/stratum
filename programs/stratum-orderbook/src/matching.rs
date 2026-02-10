use anchor_lang::prelude::*;
use crate::errors::OrderBookError;
use crate::state::OrderSide;

/// Validate that a trade can occur between maker and taker at the given price.
///
/// For a valid match:
/// - If maker is selling (Ask), taker is buying (Bid): taker_price >= maker_price
/// - If maker is buying (Bid), taker is selling (Ask): maker_price >= taker_price
///
/// In both cases, the fill price is the maker's price (price-time priority).
pub fn validate_price_match(
    maker_side: OrderSide,
    maker_price: u64,
    taker_side: OrderSide,
    taker_price: u64,
) -> Result<u64> {
    // Sides must be opposite
    require!(
        maker_side != taker_side,
        OrderBookError::InvalidOrderSide
    );

    let fill_price = match maker_side {
        OrderSide::Ask => {
            // Maker sells, taker buys: taker's bid >= maker's ask
            require!(
                taker_price >= maker_price,
                OrderBookError::PriceConstraintViolated
            );
            maker_price // fill at maker's (better) price
        }
        OrderSide::Bid => {
            // Maker buys, taker sells: maker's bid >= taker's ask
            require!(
                maker_price >= taker_price,
                OrderBookError::PriceConstraintViolated
            );
            maker_price
        }
    };

    Ok(fill_price)
}

/// Calculate the quote amount for a given fill
/// quote_amount = (fill_amount * price) / price_precision
/// Using u128 intermediate to prevent overflow
pub fn calculate_quote_amount(fill_amount: u64, price: u64, tick_size: u64) -> Result<u64> {
    let result = (fill_amount as u128)
        .checked_mul(price as u128)
        .ok_or(OrderBookError::Overflow)?
        .checked_div(tick_size as u128)
        .ok_or(OrderBookError::Overflow)?;

    require!(result <= u64::MAX as u128, OrderBookError::Overflow);
    Ok(result as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_match_ask_bid() {
        // Maker sells at 100, taker buys at 105
        let price = validate_price_match(
            OrderSide::Ask,
            100,
            OrderSide::Bid,
            105,
        )
        .unwrap();
        assert_eq!(price, 100); // fills at maker price
    }

    #[test]
    fn test_valid_match_bid_ask() {
        // Maker buys at 105, taker sells at 100
        let price = validate_price_match(
            OrderSide::Bid,
            105,
            OrderSide::Ask,
            100,
        )
        .unwrap();
        assert_eq!(price, 105); // fills at maker price
    }

    #[test]
    fn test_invalid_same_side() {
        let result = validate_price_match(
            OrderSide::Bid,
            100,
            OrderSide::Bid,
            105,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_quote_amount() {
        // 10 base tokens at price 100 with tick_size 1 = 1000 quote
        let quote = calculate_quote_amount(10, 100, 1).unwrap();
        assert_eq!(quote, 1000);
    }
}
