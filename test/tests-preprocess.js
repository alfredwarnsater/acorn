if (typeof exports !== "undefined") {
    var test = require("./driver.js").test
    var testFail = require("./driver.js").testFail
}

// #pragma is accepted but ignored
test("#pragma mark -\nx = 7;\n", {
  type: "Program",
  start: 0,
  end: 22,
  body: [
    {
      type: "ExpressionStatement",
      start: 15,
      end: 21,
      expression: {
        type: "AssignmentExpression",
        start: 15,
        end: 20,
        operator: "=",
        left: {
          type: "Identifier",
          start: 15,
          end: 16,
          name: "x"
        },
        right: {
          type: "Literal",
          start: 19,
          end: 20,
          value: 7,
          raw: "7"
        }
      }
    }
  ]
}, {
  preprocess: true
});