// Loose ambient declaration for mp4box.js — the package ships JS only and we
// intentionally talk to it through `any` shapes (sample entries, descriptor
// trees) that are too quirky to model strictly.
declare module 'mp4box' {
  const MP4Box: any;
  export default MP4Box;
}
