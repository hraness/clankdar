# Contents

- `site/` owns the static marketing and documentation pages for botcaptcha.dev.
- `site/build.ts` is the bundling entry; `site/dist/` is generated output.
- `vercel.json` sets the static build, output directory, and content security headers.

# Guidelines

- Use Bun 1.3.14. Run `bun run check:site` before handing off a site change.
- Keep pages static HTML with no client framework, no forms, and no third-party
  requests; the deployed CSP forbids all of them.
- Load presentation only from the pinned `@hraness/design-kit` release and the
  pinned `@hraness/site-footer` release; never vendor or fork their files.
- Every page contains exactly one `<!-- hraness-site-footer -->` marker; the
  build fails otherwise. The footer is configured with
  `mailingList: { kind: "none" }` and no support profile.
- Keep the shared appearance menu as the final header action.
- Keep claims honest: hashcash is implemented in the valhalla prototype;
  witness and ladder modes are specified, not shipped. Benchmark results are
  published only after a recorded calibration run.
