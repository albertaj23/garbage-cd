#pragma once

// AST for the toy language. Deliberately tiny: the language only has
// integer literals, null, identifiers, field access, `new Object()`,
// assignment, field assignment, and gc().
// Owned by Prateek.

#include <memory>
#include <string>
#include <vector>

namespace interpreter {

enum class ExprKind {
    IntLiteral,
    NullLiteral,
    Identifier,
    FieldAccess,
    NewObject
};

struct Expr {
    ExprKind kind = ExprKind::NullLiteral;

    int intValue = 0;              // IntLiteral
    std::string name;              // Identifier: variable name
                                    // FieldAccess: base object's variable name
    std::string fieldName;         // FieldAccess: field being read
};

enum class StmtKind {
    Assign,         // name = expr
    FieldAssign,    // name.field = expr
    GcCall          // gc()
};

struct Stmt {
    StmtKind kind = StmtKind::GcCall;

    std::string target;                 // Assign: variable name
                                         // FieldAssign: base object's variable name
    std::string field;                  // FieldAssign: field being written
    std::shared_ptr<Expr> value;        // Assign / FieldAssign: right-hand side
};

struct Program {
    std::vector<Stmt> statements;
};

} // namespace interpreter
