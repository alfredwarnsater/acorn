import {Parser} from "./state.js"
import {SourceLocation} from "./locutil.js"

export class Node {
  constructor(parser, pos, loc) {
    this.type = ""
    this.start = pos
    this.end = 0
    if (parser.options.locations)
      this.loc = new SourceLocation(parser, loc)
    if (parser.options.directSourceFile)
      this.sourceFile = parser.options.directSourceFile
    if (parser.options.ranges)
      this.range = [pos, 0]
  }
}

// Start an AST node, attaching a start offset.

const pp = Parser.prototype

pp.startNode = function() {
  return new Node(this, this.start + this.tokMacroOffset, this.startLoc)
}

pp.startNodeAt = function(pos, loc) {
  return new Node(this, pos, loc)
}

// Start a node whose start offset/comments information should be
// based on the start of another node. For example, a binary
// operator node is only started after its left-hand side has
// already been parsed.

pp.startNodeFrom = function(other) {
  let node = new Node(this)
  node.start = other.start
  if (other.commentsBefore) {
    node.commentsBefore = other.commentsBefore
    delete other.commentsBefore
  }
  if (other.spacesBefore) {
    node.spacesBefore = other.spacesBefore
    delete other.spacesBefore
  }
  if (this.options.locations) {
    node.loc = new SourceLocation(this, node.start, node.end)
    node.loc.start = other.loc.start
  }
  if (this.options.ranges)
    node.range = [other.range[0], 0]

  return node
}

// Finish an AST node, adding `type` and `end` properties.

function finishNodeAt(node, type, pos, loc) {
  node.type = type
  node.end = pos
  if (this.options.locations)
    node.loc.end = loc
  if (this.options.ranges)
    node.range[1] = pos
  return node
}

pp.finishNode = function(node, type) {
  return finishNodeAt.call(this, node, type, this.lastTokEnd + this.lastTokMacroOffset, this.lastTokEndLoc)
}

// Finish node at given position

pp.finishNodeAt = function(node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc)
}

pp.copyNode = function(node) {
  let newNode = new Node(this, node.start, this.startLoc)
  for (let prop in node) newNode[prop] = node[prop]
  return newNode
}
