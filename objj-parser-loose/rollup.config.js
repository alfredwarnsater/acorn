import buble from "@rollup/plugin-buble"

export default {
  external: ["objj-parser"],
  input: "objj-parser-loose/src/index.js",
  output: [
    {
      file: "objj-parser-loose/dist/objj-parser-loose.js",
      format: "umd",
      name: "objjParser.loose",
      globals: {objjParser: "objj-parser"},
      sourcemap: true
    },
    {
      file: "objj-parser-loose/dist/objj-parser-loose.mjs",
      format: "es",
      globals: {objjParser: "objj-parser"}
    }
  ],
  plugins: [
    buble({transforms: {dangerousForOf: true}})
  ]
}
