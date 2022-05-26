# build zokrates from source for local verify
FROM rust:1 AS builder
RUN curl -sS https://setup.inaccel.com/repository | sh \
 && apt install -y cmake coral-api libboost-all-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Zokrates
RUN git clone --depth 1 https://github.com/zkaccel/ZoKrates.git
WORKDIR /app/ZoKrates
ENV WITH_LIBSNARK=1
RUN ./build_release.sh
