// The public half of a made-up key pair. The secret_access stories seal to it, and test/browser/secret-access.spec.ts
// holds the private half to open what the page sealed. It guards nothing.
export const TEST_PUBLIC_KEY = {"kty":"RSA","n":"6XaDQG2jdWzhO01FpWdXmoJzbN2aIPFDgyxYNSwhFjVPUj-HiFdyHthMqUFiDK4eTip1Kl9Dsp7b34VyChUbiTmsj6ytzHsqtXcMwzlytPzKFjbRcPhwgLJgkHP2f7nejJI432-FVKMPkwuR8RTpJhxlaKssXU9RqbznffoU4OU2Pn0fcAzLfrCWLpc-Q-n2ecNLSbcukFYo5eUIYeSAR4NfDypnKbPIYVn2lsg4RNpg45CGT2wUMorcaFmpToheKc8XVUNGKJ8oYLze4lu8qwr1z2ij9V-aHOcXh3MhXWLVLZdRJW_3IiDp3GQjXLcHZaF6R5zTAjM4ODpZXtTvBw","e":"AQAB"};
