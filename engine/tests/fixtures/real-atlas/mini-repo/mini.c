#include "mini.h"

static int normalize(int value)
{
    return value < 0 ? 0 : value;
}

int clamp_value(int value)
{
    return normalize(value);
}

int submit(int value)
{
    return clamp_value(value) + 1;
}
