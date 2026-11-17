/** A stylesheet's text, imported as a string (`loader` in vite.config.ts; Vite does it in tests). */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
