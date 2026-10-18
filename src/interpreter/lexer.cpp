#include "interpreter/lexer.hpp"

#include <cctype>
#include <stdexcept>

namespace interpreter {

namespace {

bool isIdentStart(char c) {
    return std::isalpha(static_cast<unsigned char>(c)) || c == '_';
}

bool isIdentChar(char c) {
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
}

} // namespace

Lexer::Lexer(std::string source) : source_(std::move(source)), pos_(0) {}

std::vector<Token> Lexer::tokenize() {
    std::vector<Token> tokens;

    while (pos_ < source_.size()) {
        char c = source_[pos_];

        if (std::isspace(static_cast<unsigned char>(c))) {
            pos_++;
            continue;
        }

        if (c == '=') {
            tokens.push_back(Token{TokenType::Equals, "=", 0});
            pos_++;
            continue;
        }
        if (c == '.') {
            tokens.push_back(Token{TokenType::Dot, ".", 0});
            pos_++;
            continue;
        }
        if (c == ';') {
            tokens.push_back(Token{TokenType::Semicolon, ";", 0});
            pos_++;
            continue;
        }
        if (c == '(') {
            tokens.push_back(Token{TokenType::LParen, "(", 0});
            pos_++;
            continue;
        }
        if (c == ')') {
            tokens.push_back(Token{TokenType::RParen, ")", 0});
            pos_++;
            continue;
        }

        if (std::isdigit(static_cast<unsigned char>(c))) {
            std::size_t start = pos_;
            while (pos_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[pos_]))) {
                pos_++;
            }
            std::string text = source_.substr(start, pos_ - start);

            Token token;
            token.type = TokenType::IntLiteral;
            token.text = text;
            token.intValue = std::stoi(text);
            tokens.push_back(token);
            continue;
        }

        if (isIdentStart(c)) {
            std::size_t start = pos_;
            while (pos_ < source_.size() && isIdentChar(source_[pos_])) {
                pos_++;
            }
            std::string text = source_.substr(start, pos_ - start);

            Token token;
            token.text = text;
            if (text == "new") {
                token.type = TokenType::KwNew;
            } else if (text == "Object") {
                token.type = TokenType::KwObject;
            } else if (text == "null") {
                token.type = TokenType::KwNull;
            } else if (text == "gc") {
                token.type = TokenType::KwGc;
            } else {
                token.type = TokenType::Identifier;
            }
            tokens.push_back(token);
            continue;
        }

        throw std::runtime_error(std::string("Lexer: unexpected character '") + c + "'");
    }

    tokens.push_back(Token{TokenType::EndOfFile, "", 0});
    return tokens;
}

} // namespace interpreter
