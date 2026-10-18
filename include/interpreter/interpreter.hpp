#pragma once

// interpreter::Interpreter -- walks the AST and executes it.
// Owned by Prateek. Talks to memory only through gc::IHeap; never
// includes memory/heap.hpp or memory/object.hpp.
// Execution logic itself is not implemented yet (skeleton only).

#include "gc_interface.hpp"
#include "interpreter/ast.hpp"
#include "runtime/environment.hpp"
#include "runtime/value.hpp"

namespace interpreter {

class Interpreter {
public:
    explicit Interpreter(gc::IHeap& heap);

    void run(const Program& program);

private:
    void execute(const Stmt& stmt);
    runtime::Value evaluate(const Expr& expr);

    gc::IHeap& heap_;
    runtime::Environment env_;
};

} // namespace interpreter
