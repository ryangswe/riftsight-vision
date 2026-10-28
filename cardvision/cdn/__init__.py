# SPDX-License-Identifier: Apache-2.0
"""``cardvision cdn``: one tool that publishes a product's card pictures, data files, pages,
settings file (``config.json``), geometric index and remote releases to the product's own
Cloudflare R2 bucket, and checks them over public HTTPS, driven by the product's
``cdn/cdn.config.json`` (``config``).

Modules: ``config`` (the product's settings), ``target`` (credentials and the guards that keep a
product off another project's account), ``settings`` (the config.json contract, data files,
pages), ``art`` (card pictures and the upload order), ``release`` (the local seal and the pointer
block), ``geo`` (the geometric index), ``node`` (the runtime's own check in Node), ``verify``
(read-only HTTPS checks), ``publish`` (the orders and their gates), ``commands`` (the command line).

S3 goes through a client passed in (boto3, the ``cdn`` extra, is imported only to make one), HTTPS
through a ``get`` callable and Node through a ``node`` callable, so that everything runs against
fakes in tests. Nothing here imports boto3 at import time.
"""
