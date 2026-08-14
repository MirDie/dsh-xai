//#region src/invariant.ts
const PACKAGE_NAME = "dsh-xai";
const name = "xai-oauth-invariant";
const inject = ["invariants"];
const install = () => {};
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
