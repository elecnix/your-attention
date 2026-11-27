# An example stdio secret source

`source.ts` is a secret source in the stdio form, with made-up values that open nothing. It follows the messages of [SPEC.md](../../SPEC.md#the-source-interface), with one JSON request per line on stdin and one reply per line on stdout. Logs go to stderr. `sealValue` from `src/core/sealed.ts` seals each value, so the value leaves the source only as ciphertext that the card's key opens.

Add it to the inbox of this computer:

```sh
your-attention secret source add "file://$PWD/examples/secret-source-stdio" --name example --command "node source.ts"
your-attention secret source list
```

Restart `your-attention serve` so the inbox loads it. A lookup for `{"type": "api-key", "host": "api.example.com"}` then answers the candidate `EXAMPLE_API_KEY` from the source `example`.

Talk to it by hand to see the messages:

```sh
printf '%s\n' '{"v":1,"id":"1","call":"detect"}' '{"v":1,"id":"2","call":"lookup","query":{"name":"EXAMPLE_API_KEY"}}' | node source.ts
```

A source of your own keeps its values in a real store, such as a password manager, and seals each one inside its own process. It answers only what matches the query, never its whole store, and it never answers a plain value: the inbox refuses a release without `sealed`. It reads its settings, from the entry in `~/.your-attention/sources.jsonl`, as JSON from the `YOUR_ATTENTION_SOURCE_SETTINGS` variable. `test/integration/secret-stdio.test.ts` runs this example.
