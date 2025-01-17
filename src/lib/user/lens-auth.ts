import { decodeJwt } from 'jose';

import lensApi from '../lens-api';
import type WalletConnection from '../evm/WalletConnection';

export class NoProfileError extends Error {
    constructor() {
        super('No profile found');
        this.name = 'NoProfileError';
        Object.setPrototypeOf(this, NoProfileError.prototype);
    }
}

export const authenticateUser = async (walletConnection: WalletConnection) => {
    const {
        initEthers,
        getSigner,
        getAccounts,
        clearProvider,
        ensureCorrectChain,
    } = await import('../evm/ethers-service');
    const { getDefaultProfile } = await import('./lens-profile');

    let address: string | undefined;
    try {
        const accounts = await initEthers(walletConnection);
        address = accounts[0];
    } catch (e) {
        console.warn(
            'authenticateUser: Unable to get address from cached provider',
            e
        );
    }

    if (!address) {
        try {
            const accounts = await getAccounts();
            address = accounts[0];
        } catch (e) {
            await clearProvider();
            console.error(e);
        }
    }

    if (!address) throw new Error('No address found');
    console.log('authenticate: Authenticating with address', address);

    await ensureCorrectChain();

    // Getting the challenge from the server
    const { challenge } = await lensApi.challenge({ request: { address } });
    console.log('authenticate: Lens challenge response', challenge);

    const signer = await getSigner();
    const signature = await signer.signMessage(challenge.text);
    console.log('authenticate: Signed Lens challenge', signature);

    const { authenticate } = await lensApi.authenticate({
        request: { address, signature },
    });
    console.log('authenticate: Lens auth response', authenticate);

    await chrome.storage.local.set({
        accessToken: authenticate.accessToken,
        refreshToken: authenticate.refreshToken,
    });

    const profile = await getDefaultProfile(address);
    console.log('authenticate: Default profile', profile);

    if (!profile) {
        throw new NoProfileError();
    }

    return profile;
};

/**
 * Returns a saved valid access token, or uses a saved valid refresh token to retrieve, save,
 * and return a new access token.
 *
 * @throws If there are no saved tokens
 * @throws If the saved refresh token is expired and an access token cannot be returned
 */
export const getOrRefreshAccessToken = async (): Promise<string> => {
    const accessToken = await getSavedAccessToken();
    if (!accessToken) {
        throw new Error('No saved tokens found');
    }
    // console.log('getOrRefreshAccessToken: found saved access token');

    const now = Date.now();

    const accessTokenExpiration = (decodeJwt(accessToken).exp ?? 0) * 1000; // convert to ms
    if (accessTokenExpiration > now) {
        // const duration = Duration.fromMillis(accessTokenExpiration - now).shiftTo('minutes');
        // console.log(`getOrRefreshAccessToken: saved access token expires in ${duration.toHuman()}`);
        return accessToken;
    }

    // console.log('getOrRefreshAccessToken: Access token is expired.');

    const savedRefreshToken = await getSavedRefreshToken();
    if (!savedRefreshToken) {
        throw new Error('No saved refresh token found');
    }
    // console.log('getOrRefreshAccessToken: found saved refresh token')

    const refreshTokenExpiration =
        (decodeJwt(savedRefreshToken).exp ?? 0) * 1000; // convert to ms
    if (refreshTokenExpiration > now) {
        return refreshAccessToken(savedRefreshToken);
    } else {
        await logOut();
        throw new Error('Refresh token is expired');
    }
};

export const getSavedAccessToken = async (): Promise<string | undefined> => {
    const storage = await chrome.storage.local.get(['accessToken']);
    return storage.accessToken;
};

export const getSavedRefreshToken = async (): Promise<string | undefined> => {
    const storage = await chrome.storage.local.get(['refreshToken']);
    return storage.refreshToken;
};

export const refreshAccessToken = async (
    refreshToken?: string
): Promise<string> => {
    if (!refreshToken) {
        refreshToken = await getSavedRefreshToken();
    }

    // console.log('refreshAccessToken: Refreshing access token with refresh token...');

    const { refresh } = await lensApi.refresh({ request: { refreshToken } });

    return new Promise((resolve, reject) => {
        chrome.storage.local.set(
            {
                accessToken: refresh.accessToken,
                refreshToken: refresh.refreshToken,
            },
            async () => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                const accessToken = await getSavedAccessToken();
                if (!accessToken) {
                    return reject('No access token saved');
                }
                // console.log('Saved new access token to local storage');
                resolve(accessToken);
            }
        );
    });
};

export const logOut = async () => {
    const { clearProvider } = await import('../evm/ethers-service');
    await chrome.storage.local.clear();
    await chrome.runtime.sendMessage({ type: 'loggedOut' });
    await clearProvider();
};
