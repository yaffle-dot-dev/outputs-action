# Contributing

Thanks for helping improve Yaffle Outputs Action.

## Source and sync model

- Yaffle maintainers primarily work in the main Yaffle monorepo.
- Community contributions are welcome in this public repository.
- Accepted public changes are synced back into the monorepo and then synced forward again.

## Before you open a PR

Run:

```bash
npm ci
npm run typecheck
npm run build
```

Commit the updated `dist/index.js` if the build changes it.

## License

By intentionally submitting a contribution, you agree that your contribution will be licensed under the MIT license for this project.
