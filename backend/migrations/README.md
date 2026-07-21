# Backend database migrations

Migrations are globally ordered, paired SQL files:

```text
0001_short_description.up.sql
0001_short_description.down.sql
```

Use the next unused numeric prefix. Both files are required. Applied migrations
are checksummed; never edit one after release—add a new pair instead. The runner
serializes migration attempts with a PostgreSQL advisory lock and applies each
requested batch in one transaction.

No product tables are required by the platform bootstrap. The first feature
that owns a table adds migration `0001`.

After building the backend, apply pending migrations with `pnpm migrate` from
the backend package. `YUKI_DATABASE_URL` is required. A deliberate one-step
rollback is available as `pnpm migrate:down`; pass a larger step count directly
to the built command only during an operator-controlled recovery.
