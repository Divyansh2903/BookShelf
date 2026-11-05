# AWS Certified Solutions Architect - Associate SAA-C03 Exam Tricks

<<<SECTION 1>>>
I cleared my Certified Solutions Architect-Associate (SAA-C03) exam on the first attempt, so I thought I could help others with this article where I will list some of the most common patterns in these exams and what option must be chosen in every case. Prepare well for the exam, and use this article when you have to revise all the concepts in one go. I hope it’ll help you all. Cheers!

The content in this article is written in this format — (Keyword in the question — > Correct Answer/Service)

1. Restrict access to some countries -> **CloudFront ( Geo Restriction )**
1. Protection against SQL injection or cross-site scripting/ Protect your web app & API -> **AWS WAF**
1. DDOS attacks -> **AWS Shield**
1. Preserve the contents of an instance -> **Hibernate mode in EC2**
1. Accessing DynamoDB or S3 from a private subnet within an AWS network -> **VPC endpoint**
1. Credentials in a database -> **AWS Secrets Manager**
1. Preventing accidental deletion of objects in S3 -> **Enable** **Versioning + MFA**
1. File Systems in multiple EC2 instances/Hierarchical directory structure/ Linux File Server-> **EFS**
1. Increase performance for read operations in RDS -> **Read Replicas**
1. Querying data in a storage system -> **S3 + Athena**
1. Handle requests with low latency for TCP -> **Network Load Balancer(NLB)**
1. Path/Host based routing with HTTP/HTTPS Traffic -> **Application Load Balancer (ALB)**
1. Hosting Static Content -> **S3 static hosting**
1. Download/Upload data greater than 20GB -> **S3 Transfer Acceleration**
1. Unpredictable object access pattern -> **S3 Intelligent tiering**
1. Frequent Access and high performance -> **S3 standard**
1. Infrequent access but fast retrieval -> **S3 Standard -IA (S3 One Zone-IA if high availability isn’t mentioned + cost is low)**
1. Preserve for a long time + slow retrieval -> **S3 Glacier Deep Archive**
1. Prevention of any type of modifications of objects -> **S3 Object Lock**
1. Serverless, Scalable, and elastic architecture for API -> **API Gateway + Lambda**
1. SMB file store + Gaming App (HPC workload) -> **Amazon FSx**
1. Work time is less than 15 mins + less than 512MB of memory -> **AWS lambda**
1. Real-time ingestion of streaming data (logs, IoT, clickstream, event data) -> **Kinesis Data Streams**
1. Delivering streaming data to destinations like S3, Redshift -> **Kinesis Data Firehose**
1. Real-time analytics on streaming data using SQL, Apache Flink -> **Kinesis Data Analytics**
1. Decoupling apps/Asynchronous working -> **SQS**
1. Duplicate messages in the queue -> **Increase VisibilityTimeout**
1. Low Latency for HPC in EC2 instances -> **Cluster Placement Group**
1. Migration of NFS or SMB server from on-prem to AWS -> **AWS DataSync but you can also use AWS Storage Gateway (for hybrid cloud use cases)**
1. Encrypt data during transit -> **SSL/TLS or Client Side Encryption**
1. HPC for Linux-> **FSx for Lustre**
1. Windows File Server -> **FSx for Windows**
1. Low Latency+Temporary storage for EC2 instances -> **Instance store**
1. Global Audience with TCP-based connection/ Reduce latency for global users with TCP-based connection -> **AWS Global Accelerator**
1. Complicated analytical queries using joins -> **Redshift**
1. ETL (extract, transform, and load) jobs / Convert .csv files to parquet format-> **AWS Glue**
1. SQL Database to be deployed across multiple AWS regions -> **Aurora global database**
1. AWS will manage both data key & master key -> **Server-side encryption with Amazon S3 Managed Keys (SSE-S3)**
1. AWS will manage the data key & the customer will manage the master key -> **Server-side encryption with AWS KMS-manged keys ( SSE-KMS )**
1. The customer will manage both data key & master key →  
**Server-side encryption with customer-provided keys (SSE-C)**
1. EBS volume for millisecond latency -> **Provisioned IOPS SSD ( io1)**
1. Identify users who have attached IAM policies/ Info about configurations -> **AWS Config**
1. Restrict access to S3 from CloudFront -> **Origin Access Identity ( OAI )**
1. AWS Storage gateway file gateway -> **NFS or SMB**
1. Monitor and safeguard organizations from cyberattacks -> **AWS GuardDuty**
1. Replicate S3 data from one region to another region -> **S3 Cross-Region Replication**
1. Expected spike in traffic/ predictable load for certain days -> **EC2 scheduled scaling or predictive scaling**
1. Scaling metric and set a target value ( like CPU 40% ) -> **Target Tracking**
1. Redirect traffic from one region resources to another -> **Route 53 geoproximity**
1. Redirect traffic based on location of user -> **Route 53 Geolocation**
1. High availability (in almost all cases) -> **Multi-AZ Deployment**
1. Vulnerability in your application -> **AWS Inspector**
1. Centralized maintenance & governance system -> **AWS Organizations**
1. Temporary ability for one service to access another service securely -> **IAM Roles**
1. Instance level changes -> **Security Groups**
1. Subnet level changes -> **NACLs**
1. Low latency + static hosting -> **Cloudfront and S3 static hosting**
1. Establish low-cost, immediate on-premises to aws connection without large bandwidth-> **Site-to-Site VPN**
1. Dedicated private link to AWS from on-premises data center -> **AWS Direct Connect**
1. Large-scale data migrations (10 TB — petabytes) -> **AWS Snowball**
1. Transferring exabytes (100+ PB) of data -> **AWS Snowmobile**
1. No SQL database with high performance/ Unclear about the database schema/Key Value based-> **AWS DynamoDB**
1. Structured data with relationships, transactions, ACID compliance-> **AWS RDS ( AWS Aurora if high performance is mentioned)**
1. Flexible JSON document storage, schema-less design (MongoDB) -> **AWS DocumentDB**
1. Image & video analysis (face detection, object recognition, OCR) -> **Amazon Rekognition**
1. Natural language processing (NLP) for sentiment analysis, key phrase extraction (what’s written in the text) -> **Amazon Comprehend**
1. Text-to-speech conversion -> **Amazon Polly**
1. Extract text & data from documents (OCR + table extraction) -> **Amazon Textract**

That's all, folks..Cheers! All the best for the exam!
