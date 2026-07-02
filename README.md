# CheckDeployManager

Multi tenant configuration service for the [Check by CyberDrain](https://docs.check.tech) browser extension, hosted entirely on Cloudflare Workers. Built for MSPs that manage Check across many client organizations.

This is a stub README; full documentation lands with the packaging phase.

## Local development

```
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npx wrangler dev
# open http://localhost:8787/manage
```

## License

MIT
