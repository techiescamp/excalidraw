import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, PutBucketCorsCommand, GetBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand, GetBucketVersioningCommand,
} from "@aws-sdk/client-s3";

const { S3_BUCKET, AWS_REGION, S3_ENDPOINT, APP_ORIGIN } = process.env;
const s3 = new S3Client({ region: AWS_REGION, endpoint: S3_ENDPOINT, forcePathStyle: false });

const step = async (label, fn) => {
  try { const r = await fn(); console.log(`  OK   ${label}${r ? " — " + r : ""}`); }
  catch (e) { console.log(`  FAIL ${label} — ${e.name}: ${e.message}`); }
};

console.log(`bucket=${S3_BUCKET} region=${AWS_REGION} endpoint=${S3_ENDPOINT}`);

await step("list bucket", async () => {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, MaxKeys: 5 }));
  return `${r.KeyCount ?? 0} objects`;
});
await step("put object", () => s3.send(new PutObjectCommand({
  Bucket: S3_BUCKET, Key: "_healthcheck.txt", Body: "ok", ContentType: "text/plain" })));
await step("get object", async () => {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: "_healthcheck.txt" }));
  return await r.Body.transformToString();
});
await step("delete object", () => s3.send(new DeleteObjectCommand({
  Bucket: S3_BUCKET, Key: "_healthcheck.txt" })));
await step("versioning support", async () => {
  const r = await s3.send(new GetBucketVersioningCommand({ Bucket: S3_BUCKET }));
  return `Status=${r.Status ?? "(none)"}`;
});
await step("put CORS", () => s3.send(new PutBucketCorsCommand({
  Bucket: S3_BUCKET,
  CORSConfiguration: { CORSRules: [{
    AllowedOrigins: [APP_ORIGIN], AllowedMethods: ["GET", "PUT", "HEAD"],
    AllowedHeaders: ["*"], ExposeHeaders: ["ETag", "Content-Length"], MaxAgeSeconds: 3000,
  }] },
})));
await step("read CORS back", async () => {
  const r = await s3.send(new GetBucketCorsCommand({ Bucket: S3_BUCKET }));
  return JSON.stringify(r.CORSRules?.[0]?.AllowedOrigins);
});
await step("put lifecycle", () => s3.send(new PutBucketLifecycleConfigurationCommand({
  Bucket: S3_BUCKET,
  LifecycleConfiguration: { Rules: [
    { ID: "expire-share-links", Status: "Enabled", Filter: { Prefix: "shareLinks/" },
      Expiration: { Days: 365 } },
    { ID: "abort-mpu", Status: "Enabled", Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
  ] },
})));
