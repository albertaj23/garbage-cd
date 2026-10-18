#pragma once

#include <cstdio>
#include <cstdlib>

#define CHECK(condition)                                                        \
    do {                                                                        \
        if (!(condition)) {                                                     \
            std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,      \
                         __LINE__, #condition);                                \
            std::abort();                                                       \
        }                                                                       \
    } while (false)

#define CHECK_EQ(actual, expected)                                              \
    do {                                                                        \
        if (!((actual) == (expected))) {                                        \
            std::fprintf(stderr, "CHECK_EQ failed at %s:%d: %s == %s\n",       \
                         __FILE__, __LINE__, #actual, #expected);              \
            std::abort();                                                       \
        }                                                                       \
    } while (false)
