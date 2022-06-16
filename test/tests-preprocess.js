if (typeof exports !== "undefined") {
    var test = require("./driver.js").test
    var testFail = require("./driver.js").testFail
}

test("#define martin\n#ifdef carlberg\nvar b;\n#else\n#ifdef martin\nthis\n#else\nvar i;\n#endif\n#endif\n", {
  type: "Program",
  start: 0,
  end: 90,
  loc: {
    start: {
      line: 1,
      column: 0
    },
    end: {
      line: 11,
      column: 0
    }
  },
  body: [
    {
      type: "ExpressionStatement",
      start: 58,
      end: 62,
      loc: {
        start: {
          line: 6,
          column: 0
        },
        end: {
          line: 6,
          column: 4
        },
      },
      expression: {
        type: "ThisExpression",
        start: 58,
        end: 62,
        loc: {
          start: {
            line: 6,
            column: 0
          },
          end: {
            line: 6,
            column: 4
          },
        }
      }
    }
  ]
}, {
  locations: true,
  preprocess: true
});
