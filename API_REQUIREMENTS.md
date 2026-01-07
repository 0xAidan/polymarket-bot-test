# Polymarket API Requirements

To complete the copytrade bot, we need the following information from Polymarket's API documentation:

## 1. Authentication

- **How to authenticate** with the API
  - API key format and where to send it (header, query param, etc.)
  - Any required signatures or wallet-based authentication
  - Token-based auth (if applicable)

## 2. Trading Endpoints

- **Place Order Endpoint**
  - URL and HTTP method (POST, PUT, etc.)
  - Request body format:
    - Market ID
    - Outcome (YES/NO)
    - Side (BUY/SELL)
    - Amount
    - Price
    - Any other required fields
  - Response format:
    - Order ID
    - Transaction hash
    - Status codes

- **Order Status Endpoint**
  - How to check if an order was filled
  - Order history endpoint

## 3. Market Data Endpoints

- **Get Market Info**
  - Market ID format
  - Market details (outcomes, prices, etc.)
  - Current liquidity

## 4. Blockchain/On-Chain Integration

- **Polymarket Contract Addresses**
  - Main trading contract address on Polygon
  - Conditional token contract addresses
  - Any other relevant contracts

- **Event Names**
  - What events are emitted when trades occur
  - Event parameters (maker, taker, marketId, amount, etc.)
  - Example: `OrderFilled(address maker, address taker, ...)`

- **ABI (Application Binary Interface)**
  - Contract ABIs for parsing events
  - Function signatures for interacting with contracts

## 5. Wallet Monitoring

- **How to identify Polymarket trades**
  - Which contract interactions count as trades
  - Transaction input data format
  - Event log structure

## Useful Resources

Please provide links to:
- [Polymarket API Documentation](https://docs.polymarket.com)
- [CLOB API Documentation](https://docs.polymarket.com/quickstart/clob-api)
- [Gamma API Documentation](https://docs.polymarket.com/quickstart/gamma-api)
- Contract addresses and ABIs
- Authentication examples

Once we have this information, we can:
1. Implement proper authentication
2. Connect wallet monitoring to actual Polymarket contract events
3. Execute trades via the API
4. Handle errors and edge cases properly
