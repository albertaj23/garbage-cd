#include "interpreter/parser.hpp"

#include <stdexcept>

namespace interpreter {

Parser::Parser(std::vector<Token> tokens) : tokens_(std::move(tokens)), pos_(0) {}

Program Parser::parseProgram() {
    Program program;

    auto peek = [this]() -> const Token& {
        return tokens_[pos_];
    };

    auto advance = [this]() -> Token {
        return tokens_[pos_++];
    };

    auto expect = [&peek, &advance](TokenType type, const char* what) -> Token {
        if (peek().type != type) {
            throw std::runtime_error(
                std::string("Parser: expected ") + what + " but got '" + peek().text + "'");
        }
        return advance();
    };

    // Only ever needs to parse a single primary expression: the toy
    // language has no operators, so there is no precedence to handle.
    auto parseExpr = [&peek, &advance, &expect]() -> std::shared_ptr<Expr> {
        auto expr = std::make_shared<Expr>();

        if (peek().type == TokenType::IntLiteral) {
            Token t = advance();
            expr->kind = ExprKind::IntLiteral;
            expr->intValue = t.intValue;
            return expr;
        }

        if (peek().type == TokenType::KwNull) {
            advance();
            expr->kind = ExprKind::NullLiteral;
            return expr;
        }

        if (peek().type == TokenType::KwNew) {
            advance();
            expect(TokenType::KwObject, "'Object'");
            expect(TokenType::LParen, "'('");
            expect(TokenType::RParen, "')'");
            expr->kind = ExprKind::NewObject;
            return expr;
        }

        if (peek().type == TokenType::Identifier) {
            Token base = advance();
            if (peek().type == TokenType::Dot) {
                advance();
                Token field = expect(TokenType::Identifier, "field name");
                expr->kind = ExprKind::FieldAccess;
                expr->name = base.text;
                expr->fieldName = field.text;
                return expr;
            }
            expr->kind = ExprKind::Identifier;
            expr->name = base.text;
            return expr;
        }

        throw std::runtime_error("Parser: expected an expression but got '" + peek().text + "'");
    };

    while (peek().type != TokenType::EndOfFile) {
        if (peek().type == TokenType::KwGc) {
            advance();
            expect(TokenType::LParen, "'('");
            expect(TokenType::RParen, "')'");
            expect(TokenType::Semicolon, "';'");

            Stmt stmt;
            stmt.kind = StmtKind::GcCall;
            program.statements.push_back(stmt);
            continue;
        }

        Token name = expect(TokenType::Identifier, "identifier");

        if (peek().type == TokenType::Dot) {
            advance();
            Token field = expect(TokenType::Identifier, "field name");
            expect(TokenType::Equals, "'='");
            auto value = parseExpr();
            expect(TokenType::Semicolon, "';'");

            Stmt stmt;
            stmt.kind = StmtKind::FieldAssign;
            stmt.target = name.text;
            stmt.field = field.text;
            stmt.value = value;
            program.statements.push_back(stmt);
            continue;
        }

        expect(TokenType::Equals, "'='");
        auto value = parseExpr();
        expect(TokenType::Semicolon, "';'");

        Stmt stmt;
        stmt.kind = StmtKind::Assign;
        stmt.target = name.text;
        stmt.value = value;
        program.statements.push_back(stmt);
    }

    return program;
}

} // namespace interpreter
