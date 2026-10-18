#include "toy_ast_json.hpp"

#include <algorithm>
#include <string>

#include "json_writer.hpp"

namespace {

std::string shorten(std::string value) {
    constexpr std::size_t maxLabelLength = 80;
    if (value.size() > maxLabelLength) {
        value.resize(maxLabelLength);
    }
    return value;
}

const char* expressionKind(interpreter::ExprKind kind) {
    switch (kind) {
    case interpreter::ExprKind::IntLiteral:
        return "IntLiteral";
    case interpreter::ExprKind::NullLiteral:
        return "NullLiteral";
    case interpreter::ExprKind::Identifier:
        return "Identifier";
    case interpreter::ExprKind::FieldAccess:
        return "FieldAccess";
    case interpreter::ExprKind::NewObject:
        return "NewObject";
    }
    return "Unknown";
}

void writeSpan(JsonWriter& writer, const SourceSpan& span) {
    writer.beginObject();
    writer.key("start");
    writer.number(span.start);
    writer.key("end");
    writer.number(span.end);
    writer.key("line");
    writer.number(span.line);
    writer.key("column");
    writer.number(span.column);
    writer.key("endLine");
    writer.number(span.endLine);
    writer.key("endColumn");
    writer.number(span.endColumn);
    writer.key("provenance");
    writer.string("derived");
    writer.endObject();
}

void writeExpression(JsonWriter& writer, const interpreter::Expr& expression,
                     std::uint64_t& nextId) {
    writer.beginObject();
    writer.key("id");
    writer.number(nextId++);
    writer.key("kind");
    writer.string(expressionKind(expression.kind));
    writer.key("label");
    switch (expression.kind) {
    case interpreter::ExprKind::IntLiteral:
        writer.string(std::to_string(expression.intValue));
        break;
    case interpreter::ExprKind::NullLiteral:
        writer.string("null");
        break;
    case interpreter::ExprKind::Identifier:
        writer.string(shorten(expression.name));
        break;
    case interpreter::ExprKind::FieldAccess:
        writer.string(shorten(expression.name + "." + expression.fieldName));
        break;
    case interpreter::ExprKind::NewObject:
        writer.string("Object");
        break;
    }
    writer.key("children");
    writer.beginArray();
    writer.endArray();
    writer.endObject();
}

void writeStatement(JsonWriter& writer, const interpreter::Stmt& statement,
                    const SourceSpan& span, std::uint64_t& nextId,
                    bool includeExpression) {
    writer.beginObject();
    writer.key("id");
    writer.number(nextId++);
    writer.key("kind");
    if (statement.kind == interpreter::StmtKind::Assign) {
        writer.string("Assign");
        writer.key("label");
        writer.string(shorten(statement.target));
    } else if (statement.kind == interpreter::StmtKind::FieldAssign) {
        writer.string("FieldAssign");
        writer.key("label");
        writer.string(shorten(statement.target + "." + statement.field));
    } else {
        writer.string("GcCall");
        writer.key("label");
        writer.string("gc");
    }
    writer.key("span");
    writeSpan(writer, span);
    writer.key("children");
    writer.beginArray();
    if (statement.value && includeExpression) {
        writeExpression(writer, *statement.value, nextId);
    }
    writer.endArray();
    writer.endObject();
}

} // namespace

std::string writeToyAstJson(const interpreter::Program& program,
                            const std::vector<SourceSpan>& spans,
                            std::uint64_t& nodeCount, bool& truncated) {
    constexpr std::uint64_t maxNodes = 5000;
    JsonWriter writer;
    std::uint64_t nextId = 0;
    const std::size_t statementLimit =
        std::min(program.statements.size(), static_cast<std::size_t>(maxNodes - 1));
    std::size_t expressionBudget =
        static_cast<std::size_t>(maxNodes - 1 - statementLimit);
    truncated = statementLimit != program.statements.size();

    writer.beginObject();
    writer.key("id");
    writer.number(nextId++);
    writer.key("kind");
    writer.string("Program");
    writer.key("children");
    writer.beginArray();
    for (std::size_t i = 0; i < statementLimit; ++i) {
        const bool includeExpression =
            program.statements[i].value != nullptr && expressionBudget > 0;
        if (includeExpression) {
            --expressionBudget;
        } else if (program.statements[i].value) {
            truncated = true;
        }
        writeStatement(writer, program.statements[i], spans.at(i), nextId,
                       includeExpression);
    }
    writer.endArray();
    writer.endObject();
    nodeCount = nextId;
    return writer.str();
}
