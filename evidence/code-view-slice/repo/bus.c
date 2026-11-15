enum Event {
    DEFAULT_ROUTE = 1, STUB_ROUTE = 2, STORE_ROUTE = 3,
    REQUEST = 4, LOOKUP = 5, CHECK_LENGTH = 6, WRITE = 7,
    INVALID = 8, TRANSFER = 9, STAGE = 10, ENCODE = 11, COMMIT = 12,
    DIRECT = 13, BUFFERED = 14, LOCK = 15, LIBRARY = 16, IRQ = 17, UNREGISTER = 18,
    DOORBELL = 19
};

extern void trace(int event, unsigned a, unsigned b, unsigned c, unsigned line);
extern int platform_write(unsigned address, unsigned value);
extern void platform_reset(void);
#define TRACE(event, a, b, c) trace(event, a, b, c, __LINE__)

enum { CHANNEL_COUNT = 4, TX_DOORBELL = 0x1040, DIRECT_LIMIT = 48 };

struct Route {
    unsigned lane;
    unsigned max_len;
};

static const struct Route route_defaults[CHANNEL_COUNT] = {
    {0, 32}, {2, 64}, {1, 96}, {3, 128}
};

/* A max_len of zero marks an unregistered channel. */
static struct Route routes[CHANNEL_COUNT];
static unsigned staged_lengths[CHANNEL_COUNT];
static unsigned transfer_lock;
static unsigned irq_count;

void reset(void)
{
    for (unsigned channel = 0; channel < CHANNEL_COUNT; ++channel) {
        routes[channel].lane = 0;
        routes[channel].max_len = 0;
        staged_lengths[channel] = 0;
    }
    transfer_lock = 0;
    irq_count = 0;
    platform_reset();
}

static void store_route(unsigned channel, unsigned lane, unsigned max_len)
{
    routes[channel].lane = lane;
    routes[channel].max_len = max_len;
    TRACE(STORE_ROUTE, channel, lane, max_len);
}

int bus_register(unsigned channel)
{
    if (channel >= CHANNEL_COUNT) {
        TRACE(INVALID, channel, 0, 0);
        return -22;
    }
    const struct Route *route = &route_defaults[channel];
    TRACE(DEFAULT_ROUTE, channel, route->lane, route->max_len);
    store_route(channel, route->lane, route->max_len);
    return 0;
}

int stub_route(unsigned channel, unsigned lane, unsigned max_len)
{
    if (channel >= CHANNEL_COUNT || lane > 3 || max_len == 0 || max_len > 65535) {
        TRACE(INVALID, channel, lane, max_len);
        return -22;
    }
    TRACE(STUB_ROUTE, channel, lane, max_len);
    store_route(channel, lane, max_len);
    return 0;
}

int bus_unregister(unsigned channel)
{
    if (channel >= CHANNEL_COUNT)
        return -22;
    store_route(channel, 0, 0);
    TRACE(UNREGISTER, channel, 0, 0);
    return 0;
}

int bus_irq(void)
{
    ++irq_count;
    TRACE(IRQ, irq_count, 0, 0);
    return 0;
}

static const struct Route *lookup_route(unsigned channel)
{
    const struct Route *route = &routes[channel];
    TRACE(LOOKUP, channel, route->lane, route->max_len);
    return route->max_len ? route : 0;
}

static int check_length(const struct Route *route, unsigned length)
{
    int allowed = length <= route->max_len;
    TRACE(CHECK_LENGTH, length, route->max_len, allowed);
    return allowed;
}

static unsigned encode_doorbell(unsigned lane, unsigned length)
{
    unsigned value = (lane << 16) | length;
    TRACE(ENCODE, lane, length, value);
    return value;
}

static int write_doorbell(unsigned value)
{
    TRACE(DOORBELL, TX_DOORBELL, value, 0);
    return platform_write(TX_DOORBELL, value);
}

static int commit_transfer(unsigned lane, unsigned length)
{
    TRACE(COMMIT, lane, length, 0);
    unsigned value = encode_doorbell(lane, length);
    return write_doorbell(value);
}

static unsigned stage_payload(unsigned lane, unsigned length)
{
    staged_lengths[lane] = length;
    TRACE(STAGE, lane, staged_lengths[lane], 0);
    return staged_lengths[lane];
}

static int submit_direct(unsigned lane, unsigned length)
{
    TRACE(DIRECT, lane, length, 0);
    return commit_transfer(lane, length);
}

static int submit_buffered(unsigned lane, unsigned length)
{
    TRACE(BUFFERED, lane, length, 0);
    unsigned staged = stage_payload(lane, length);
    return commit_transfer(lane, staged);
}

static int dispatch_transfer(const struct Route *route, unsigned length)
{
    int buffered = length > DIRECT_LIMIT;
    TRACE(TRANSFER, length, buffered, DIRECT_LIMIT);
    if (buffered)
        return submit_buffered(route->lane, length);
    return submit_direct(route->lane, length);
}

int bus_send(unsigned channel, unsigned length)
{
    TRACE(REQUEST, channel, length, 0);
    if (channel >= CHANNEL_COUNT || length == 0 || length > 65535) {
        TRACE(INVALID, channel, length, 0);
        return -22;
    }

    const struct Route *route = lookup_route(channel);
    if (!route)
        return -2;

    if (!check_length(route, length))
        return -90;

    /* Serial simulator: this flag records the protected scope, without threads. */
    transfer_lock = 1;
    TRACE(LOCK, transfer_lock, 0, 0);
    int status = dispatch_transfer(route, length);
    transfer_lock = 0;
    TRACE(LOCK, transfer_lock, 0, 0);
    return status;
}
