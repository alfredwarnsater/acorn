import buble from "@rollup/plugin-buble"

export default [
  {
    input: "objj-parser/src/index.js",
    output: [
      {
        file: "objj-parser/dist/objj-parser.js",
        format: "umd",
        name: "objjParser",
        sourcemap: true
      },
      {
        file: "objj-parser/dist/objj-parser.mjs",
        format: "es"
      }
    ],
    plugins: [
      buble({transforms: {dangerousForOf: true}})
    ]
  },
  {
    external: ["objj-parser", "fs", "path"],
    input: "objj-parser/src/bin/objj-parser.js",
    output: {
      file: "objj-parser/dist/bin.js",
      format: "cjs",
      paths: {objjParser: "./objj-parser.js"}
    },
    plugins: [
      buble({transforms: {dangerousForOf: true}})
    ]
  }
]
