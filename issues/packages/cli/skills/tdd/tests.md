# Good and Bad Tests

## Good tests

An integration-style test goes through a real interface. It does not mock internal parts.

```typescript
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Look for these traits:

- Tests behavior that users or callers care about.
- Uses the public API only.
- Survives an internal refactor.
- Describes what the code does, not how.
- Has one behavior per test. More than one assertion is permitted when the assertions specify the same behavior.
- Stays as a keeper only when no other public-interface test already fails for the same reason.

## Bad tests

An implementation-detail test is tied to the internal structure.

```typescript
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Watch for these warning signs:

- Mocking internal collaborators.
- Testing private methods.
- Asserting on call counts or call order.
- Breaking on a refactor with no behavior change.
- Test names that describe how, not what.
- Checking through an external system instead of through the interface.
- Restating a static object, manifest, route table, schema, or constant map.
- Failing on an intentional declaration edit when no caller behavior changed.
- Restating the same public API and the same code path with a small fixture change.
- Existing only to complete a red-green cycle after another keeper already pins the behavior.
- Failing only when a broader public-interface test also fails.

```typescript
test("groups accounting setup modules", () => {
  expect(moduleTree).toMatchObject({
    setup: {
      accountingsetup: {
        codingtemplate: {},
        invoiceagreement: {},
      },
    },
  });
});
```

This test copies the declaration into the assertion. Test behavior that resolves or inherits modules from this hierarchy. If there is no distinct consumer behavior to test, use a type-check, lint, build, or focused inspection instead.

```typescript
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```