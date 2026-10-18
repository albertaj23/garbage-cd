#pragma once

// Tokenizer for the toy language. Owned by Prateek.
// Tokenization logic itself is not implemented yet (skeleton only).

#include <string>
#include <vector>

namespace interpreter {

enum class TokenType {
    Identifier,
    IntLiteral,
    Equals,
    Dot,
    Semicolon,
    LParen,
    RParen,
    KwNew,
    KwObject,
    KwNull,
    KwGc,
    EndOfFile
};

struct Token {
    TokenType type = TokenType::EndOfFile;
    std::string text;
    int intValue = 0;
};

class Lexer {
public:
    explicit Lexer(std::string source);

    std::vector<Token> tokenize();

private:
    std::string source_;
    std::size_t pos_ = 0;
};

} // namespace interpreter
