#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "interpreter/ast.hpp"
#include "interpreter/interpreter.hpp"
#include "interpreter/lexer.hpp"
#include "interpreter/parser.hpp"
#include "memory/heap.hpp"

// Entry point: reads a script, lexes/parses it into a Program, then runs
// it through the interpreter, which talks to the memory subsystem only
// through gc::IHeap.
int main(int argc, char** argv) {
    std::string path = argc > 1 ? argv[1] : "examples/sample_program.txt";

    std::ifstream file(path);
    if (!file) {
        std::cerr << "Could not open script: " << path << "\n";
        return 1;
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string source = buffer.str();

    interpreter::Lexer lexer(source);
    interpreter::Parser parser(lexer.tokenize());
    interpreter::Program program = parser.parseProgram();

    memory::Heap heap;
    interpreter::Interpreter interp(heap);
    interp.run(program);

    return 0;
}
