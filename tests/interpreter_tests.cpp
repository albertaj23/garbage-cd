// Smoke tests for the interpreter/runtime implementation. Owned by Prateek.
// Plain asserts, no external test framework.
//
// Uses memory::Heap only as a concrete gc::IHeap to run the interpreter
// end-to-end; the interpreter itself never depends on memory/heap.hpp.

#include <cassert>
#include <iostream>
#include <string>

#include "interpreter/interpreter.hpp"
#include "interpreter/lexer.hpp"
#include "interpreter/parser.hpp"
#include "memory/heap.hpp"
#include "runtime/environment.hpp"
#include "runtime/value.hpp"

namespace {

void testValueAndEnvironment() {
    runtime::Value nullValue;
    assert(nullValue.isNull());

    runtime::Value intValue(42);
    assert(intValue.isInt());
    assert(intValue.asInt() == 42);

    gc::ObjectHandle handle(3);
    runtime::Value objValue(handle);
    assert(objValue.isObject());
    assert(objValue.asObject() == handle);

    runtime::Environment env;
    assert(!env.has("a"));
    env.define("a", intValue);
    assert(env.has("a"));
    assert(env.get("a").asInt() == 42);
}

void testLexerAndParser() {
    interpreter::Lexer lexer("a = new Object(); a.ref = null; gc();");
    auto tokens = lexer.tokenize();
    assert(!tokens.empty());
    assert(tokens.back().type == interpreter::TokenType::EndOfFile);

    interpreter::Parser parser(tokens);
    interpreter::Program program = parser.parseProgram();

    assert(program.statements.size() == 3);
    assert(program.statements[0].kind == interpreter::StmtKind::Assign);
    assert(program.statements[0].target == "a");
    assert(program.statements[0].value->kind == interpreter::ExprKind::NewObject);

    assert(program.statements[1].kind == interpreter::StmtKind::FieldAssign);
    assert(program.statements[1].target == "a");
    assert(program.statements[1].field == "ref");
    assert(program.statements[1].value->kind == interpreter::ExprKind::NullLiteral);

    assert(program.statements[2].kind == interpreter::StmtKind::GcCall);
}

void testInterpreterEndToEnd() {
    const std::string source =
        "a = new Object();"
        "b = new Object();"
        "a.ref = b;"
        "a = null;"
        "b = null;"
        "gc();";

    interpreter::Lexer lexer(source);
    interpreter::Parser parser(lexer.tokenize());
    interpreter::Program program = parser.parseProgram();

    memory::Heap heap;
    interpreter::Interpreter interp(heap);
    interp.run(program);

    gc::GCStats stats = heap.getStats();
    assert(stats.totalAllocations == 2);
    assert(stats.totalCollections == 1);
}

} // namespace

int main() {
    testValueAndEnvironment();
    testLexerAndParser();
    testInterpreterEndToEnd();

    std::cout << "interpreter_tests: all smoke tests passed.\n";
    return 0;
}
