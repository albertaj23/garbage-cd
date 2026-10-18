#pragma once

// Parser for the toy language. Owned by Prateek.
// Parsing logic itself is not implemented yet (skeleton only).

#include <vector>

#include "interpreter/ast.hpp"
#include "interpreter/lexer.hpp"

namespace interpreter {

class Parser {
public:
    explicit Parser(std::vector<Token> tokens);

    Program parseProgram();

private:
    std::vector<Token> tokens_;
    std::size_t pos_ = 0;
};

} // namespace interpreter
