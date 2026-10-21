# Deep Modules

From *A Philosophy of Software Design*:

**Deep module**: a small interface with a lot of implementation behind it.

```
┌─────────────────────┐
│   Small Interface   │
├─────────────────────┤
│                     │
│                     │
│  Deep Implementation│
│                     │
│                     │
└─────────────────────┘
```

**Shallow module**: a large interface with little implementation behind it.

```
┌─────────────────────────────────┐
│       Large Interface           │
├─────────────────────────────────┤
│  Thin Implementation            │
└─────────────────────────────────┘
```

When you design an interface, ask:

- Can you reduce the number of methods?
- Can you simplify the parameters?
- Can you hide more complexity inside?