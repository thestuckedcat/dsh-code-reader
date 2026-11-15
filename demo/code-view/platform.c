extern void trace(int event, unsigned a, unsigned b, unsigned c, unsigned line);

/* The host records the simulated register write in its own source unit. */
enum { WRITE = 7, LIBRARY = 16 };
static unsigned simulated_doorbell;
static int platform_status;

void platform_reset(void)
{
    simulated_doorbell = 0;
    platform_status = 0;
}

void set_platform_stub(int status)
{
    platform_status = status;
}

int platform_write(unsigned address, unsigned value)
{
    trace(LIBRARY, address, value, (unsigned)platform_status, __LINE__);
    if (platform_status)
        return platform_status;
    unsigned before = simulated_doorbell;
    simulated_doorbell = value;
    trace(WRITE, address, simulated_doorbell, before, __LINE__);
    return 0;
}
