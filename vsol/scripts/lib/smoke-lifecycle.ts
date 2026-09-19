/** Every confirmed smoke fill gets a close attempt, even if verification fails. */
export async function verifyAndCloseSmokePosition<T>(verify: () => Promise<void>, close: () => Promise<T>): Promise<T> {
  let verificationFailure: unknown;
  try {
    await verify();
  } catch (error) {
    verificationFailure = error;
  }
  try {
    const receipt = await close();
    if (verificationFailure) throw verificationFailure;
    return receipt;
  } catch (closeFailure) {
    if (verificationFailure && closeFailure !== verificationFailure) {
      throw new AggregateError([verificationFailure, closeFailure], "Smoke verification and position cleanup both failed");
    }
    throw closeFailure;
  }
}
