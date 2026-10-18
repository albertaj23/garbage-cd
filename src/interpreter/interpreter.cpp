#include "interpreter/interpreter.hpp"

#include <iostream>
#include <stdexcept>

namespace interpreter {

Interpreter::Interpreter(gc::IHeap& heap) : heap_(heap) {}

void Interpreter::run(const Program& program) {
    for (const auto& stmt : program.statements) {
        execute(stmt);
    }
}

void Interpreter::execute(const Stmt& stmt) {
    switch (stmt.kind) {
        case StmtKind::Assign: {
            runtime::Value value = evaluate(*stmt.value);
            env_.define(stmt.target, value);

            // A variable is a GC root only while it holds an object
            // reference. Clear any previous root registration for this
            // name, then re-register only if the new value is an object.
            heap_.clearRoot(stmt.target);
            if (value.isObject()) {
                heap_.setRoot(stmt.target, value.asObject());
            }
            break;
        }

        case StmtKind::FieldAssign: {
            runtime::Value base = env_.get(stmt.target);
            if (!base.isObject()) {
                throw std::runtime_error(
                    "Interpreter: cannot assign field '" + stmt.field + "' on '" +
                    stmt.target + "' because it is not an object");
            }

            runtime::Value rhs = evaluate(*stmt.value);
            gc::ObjectHandle targetHandle = gc::ObjectHandle::invalid();
            if (rhs.isObject()) {
                targetHandle = rhs.asObject();
            } else if (!rhs.isNull()) {
                throw std::runtime_error(
                    "Interpreter: field '" + stmt.field + "' can only be assigned an object or null");
            }

            heap_.setField(base.asObject(), stmt.field, targetHandle);
            break;
        }

        case StmtKind::GcCall: {
            heap_.collect();
            gc::GCStats stats = heap_.getStats();

            std::cout << "gc() called:\n";
            std::cout << "  objects collected this run:    " << stats.objectsCollectedLastRun << "\n";
            std::cout << "  live objects after collection: " << stats.liveObjectsAfterLastRun << "\n";
            std::cout << "  total allocations so far:      " << stats.totalAllocations << "\n";
            std::cout << "  total collections so far:      " << stats.totalCollections << "\n";
            break;
        }
    }
}

runtime::Value Interpreter::evaluate(const Expr& expr) {
    switch (expr.kind) {
        case ExprKind::IntLiteral:
            return runtime::Value(expr.intValue);

        case ExprKind::NullLiteral:
            return runtime::Value();

        case ExprKind::Identifier:
            return env_.get(expr.name);

        case ExprKind::FieldAccess: {
            runtime::Value base = env_.get(expr.name);
            if (!base.isObject()) {
                throw std::runtime_error(
                    "Interpreter: cannot read field '" + expr.fieldName + "' on '" +
                    expr.name + "' because it is not an object");
            }
            gc::ObjectHandle target = heap_.getField(base.asObject(), expr.fieldName);
            if (!target.isValid()) {
                return runtime::Value(); // null
            }
            return runtime::Value(target);
        }

        case ExprKind::NewObject:
            return runtime::Value(heap_.allocate());
    }

    throw std::runtime_error("Interpreter: unknown expression kind");
}

} // namespace interpreter
