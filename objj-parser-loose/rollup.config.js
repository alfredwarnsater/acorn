import buble from "@rollup/plugin-buble"

export default {
  external: ["objj-parser"],
  input: "objj-parser-loose/src/index.js",
  output: [
    {
      file: "objj-parser-loose/dist/objj-parser-loose.js",
      format: "umd",
      name: "objjParser.loose",
      globals: {"objj-parser": "objj-parser"},
      sourcemap: true
    },
    {
      file: "objj-parser-loose/dist/objj-parser-loose.mjs",
      format: "es",
      globals: {"objj-parser": "objj-parser"}
    }
  ],
  plugins: [
    buble({transforms: {dangerousForOf: true}})
  ]
}
