import { IsNotEmpty, IsString } from 'class-validator';

export class CreateRegistrationDto {
  @IsNotEmpty()
  @IsString()
  teamId: string;

  @IsNotEmpty()
  @IsString()
  categoryId: string;
}
