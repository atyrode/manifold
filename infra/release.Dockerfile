# Select only the provenance-verified release image. No default and no source build:
# the image already supplies its runtime, identity, entrypoint and command.
ARG MANIFOLD_RELEASE_IMAGE
FROM ${MANIFOLD_RELEASE_IMAGE}
