# Interface Design for Testability

A good interface makes testing easy:

1. Accept dependencies. Do not create them inside the function.

   ```typescript
   function processOrder(order, paymentGateway) {}
   ```

2. Return a result. Do not rely on a side effect.

   ```typescript
   function calculateDiscount(cart): Discount {}
   ```

3. Keep the surface area small.

- Fewer methods need fewer tests.
- Fewer parameters need simpler test setup.