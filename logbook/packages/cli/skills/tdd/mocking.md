# When to Mock

Mock only at system boundaries:

- External APIs.
- Databases, when a test database is not practical.
- Time and randomness.
- File system access, when you need it.

Do not mock:

- Your own classes or modules.
- Internal collaborators.
- Anything you control.

## Design for Mockability

At system boundaries, design an interface that is easy to mock.

1. Use dependency injection.
2. Prefer an SDK-style interface over a generic fetcher.

The SDK approach gives you:

- One specific shape per mock.
- No conditional logic in test setup.
- A clear view of which endpoints a test uses.
- Better type safety for each endpoint.