# A recovery deployment runs the exact selected prior release with only the authenticated
# pre-start recovery helper added. The application and its Bun runtime come from the immutable
# release image; the helper is compiled separately with Manifold's pinned tooling runtime.
ARG MANIFOLD_RECOVERY_BASE_IMAGE=oven/bun:1.4.2
FROM oven/bun:1.4.2 AS recovery-build
WORKDIR /src
COPY scripts/full-state-recovery.ts ./full-state-recovery.ts
RUN bun build --compile --target=bun --outfile=/out/manifold-full-state-recovery ./full-state-recovery.ts

FROM ${MANIFOLD_RECOVERY_BASE_IMAGE}
RUN test -x /app/infra/entrypoint.sh && test -x /usr/local/bin/litestream
COPY --from=recovery-build /out/manifold-full-state-recovery /usr/local/bin/manifold-full-state-recovery
COPY --chmod=755 infra/recovery-entrypoint.sh /app/infra/recovery-entrypoint.sh
CMD ["/app/infra/recovery-entrypoint.sh"]
